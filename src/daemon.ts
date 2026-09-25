import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { loadConfig, statePaths, type Config } from './config.js';
import { Ledger } from './ledger.js';
import { SyncEngine, type SyncStats } from './engine.js';
import { acquireLock } from './lock.js';
import { log, configureLog } from './log.js';

export interface DaemonState {
  pid: number; startedAt: string; paused: boolean; syncing: boolean;
  lastRun: { at: string; trigger: string; stats: Omit<SyncStats, 'actions'> } | null;
  nextPeriodicAt: string | null; triggersSeen: Record<string, number>;
}

/**
 * Triggers (all funnel into one debounced, non-overlapping sync):
 *  - periodic: every cfg.intervalSec
 *  - fs: changes under ~/.claude/projects and ~/.codex/sessions
 *  - hook: files dropped in the spool dir by the hook shim (Claude Stop/SessionEnd, Codex notify)
 *  - socket: `ai-sync ctl sync-now`
 */
export class Daemon {
  cfg: Config;
  private ledger: Ledger;
  private engine: SyncEngine;
  private paths;
  private releaseLock: (() => void) | null = null;
  private server: net.Server | null = null;
  private watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private rerun: string | null = null;
  private stopped = false;
  state: DaemonState;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.paths = statePaths(cfg);
    this.ledger = new Ledger(this.paths.db);
    this.engine = new SyncEngine(cfg, this.ledger);
    this.state = { pid: process.pid, startedAt: new Date().toISOString(), paused: false, syncing: false, lastRun: null, nextPeriodicAt: null, triggersSeen: {} };
  }

  async start() {
    this.releaseLock = acquireLock(this.paths.lock);
    fs.mkdirSync(this.paths.spool, { recursive: true, mode: 0o700 });
    await this.listen();
    if (this.cfg.watch) this.watch();
    this.schedulePeriodic();
    log.info('daemon started', { pid: process.pid, interval: this.cfg.intervalSec, claudeDir: this.cfg.claudeDir, codexDir: this.cfg.codexDir });
    this.trigger('startup', 0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    try { fs.unlinkSync(this.paths.sock); } catch { /* gone */ }
    // wait for an in-flight sync to finish before closing the db
    while (this.state.syncing) await new Promise((r) => setTimeout(r, 50));
    this.ledger.close();
    this.releaseLock?.();
    log.info('daemon stopped');
  }

  trigger(source: string, delay = this.cfg.debounceMs) {
    if (this.stopped) return;
    this.state.triggersSeen[source] = (this.state.triggersSeen[source] ?? 0) + 1;
    if (this.state.paused && source !== 'socket') return;
    if (this.state.syncing) { this.rerun = source; return; }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.runSync(source); }, delay);
  }

  async runSync(trigger: string, extra: { dryRun?: boolean; force?: boolean; full?: boolean; backfillDays?: number } = {}): Promise<SyncStats> {
    this.state.syncing = true;
    this.drainSpool();
    let stats: SyncStats;
    try {
      stats = await this.engine.run({ trigger, ...extra });
    } finally { this.state.syncing = false; }
    const { actions, ...rest } = stats;
    if (!extra.dryRun) this.state.lastRun = { at: new Date().toISOString(), trigger, stats: rest };
    if (actions.length) log.info('sync', { trigger, ...rest, actions: actions.slice(0, 20) });
    else log.debug('sync: nothing to do', { trigger });
    if (this.rerun && !this.stopped) { const r = this.rerun; this.rerun = null; this.trigger(r); }
    return stats;
  }

  private schedulePeriodic() {
    const ms = this.cfg.intervalSec * 1000;
    this.state.nextPeriodicAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => { this.trigger('periodic', 0); this.schedulePeriodic(); }, ms);
    this.timer.unref?.();
  }

  private drainSpool() {
    let files: string[] = [];
    try { files = fs.readdirSync(this.paths.spool).filter((f) => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      const p = path.join(this.paths.spool, f);
      try { log.debug('hook event', { event: fs.readFileSync(p, 'utf8').slice(0, 500) }); fs.unlinkSync(p); } catch { /* raced */ }
    }
  }

  private watch() {
    const targets: [string, string][] = [
      [path.join(this.cfg.claudeDir, 'projects'), 'fs:claude'],
      [path.join(this.cfg.codexDir, 'sessions'), 'fs:codex'],
      [this.paths.spool, 'hook'],
    ];
    for (const [dir, source] of targets) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { recursive: source !== 'hook' }, (_ev, name) => {
          if (!name) return;
          const n = String(name);
          if (source === 'hook' ? !n.endsWith('.json') : !n.endsWith('.jsonl')) return;
          this.trigger(source);
        });
        w.on('error', (e) => log.warn('watcher error', { dir, error: String(e) }));
        this.watchers.push(w);
      } catch (e: any) {
        log.warn('cannot watch directory; relying on periodic sync', { dir, error: String(e?.message ?? e) });
      }
    }
  }

  private listen(): Promise<void> {
    try { fs.unlinkSync(this.paths.sock); } catch { /* none */ }
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', async (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let reply: unknown;
          try { reply = await this.handle(JSON.parse(line)); }
          catch (e: any) { reply = { ok: false, error: String(e?.message ?? e) }; }
          sock.write(JSON.stringify(reply) + '\n');
        }
      });
      sock.on('error', () => { /* client went away */ });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.paths.sock, () => { try { fs.chmodSync(this.paths.sock, 0o600); } catch { /* */ } resolve(); });
    });
  }

  private async handle(req: any): Promise<unknown> {
    switch (req?.cmd) {
      case 'ping': return { ok: true };
      case 'status': return { ok: true, state: this.state, links: this.ledger.links().length };
      case 'sync-now': {
        if (this.state.syncing) { this.rerun = 'socket'; return { ok: true, queued: true }; }
        const s = await this.runSync('socket', { force: !!req.force, full: !!req.full, dryRun: !!req.dryRun, backfillDays: req.backfillDays });
        return { ok: true, stats: s };
      }
      case 'pause': this.state.paused = true; return { ok: true, paused: true };
      case 'resume': this.state.paused = false; this.trigger('resume', 0); return { ok: true, paused: false };
      case 'reload': {
        const next = loadConfig({ stateDir: this.cfg.stateDir });
        Object.assign(this.cfg, next);
        if (this.timer) clearTimeout(this.timer);
        this.schedulePeriodic();
        return { ok: true, config: this.cfg };
      }
      case 'stop': setTimeout(() => void this.stop().then(() => process.exit(0)), 10); return { ok: true };
      default: return { ok: false, error: `unknown cmd ${req?.cmd}` };
    }
  }
}

/** Send one command to a running daemon. Resolves null when no daemon is listening. */
export function ctl(sockPath: string, req: object, timeoutMs = 120_000): Promise<any | null> {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve(null); }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(t); s.end(); try { resolve(JSON.parse(buf.slice(0, i))); } catch { resolve(null); } }
    });
    s.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

export async function runDaemon(cfg: Config) {
  configureLog({ file: statePaths(cfg).log });
  const d = new Daemon(cfg);
  await d.start();
  const shutdown = () => void d.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', () => { const n = loadConfig({ stateDir: cfg.stateDir }); Object.assign(d.cfg, n); log.info('config reloaded'); });
}
