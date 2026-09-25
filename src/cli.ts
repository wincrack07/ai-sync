#!/usr/bin/env node
import * as fs from 'node:fs';
import { loadConfig, statePaths, type Config } from './config.js';
import { Ledger } from './ledger.js';
import { SyncEngine, type SyncStats } from './engine.js';
import { runDaemon, ctl } from './daemon.js';
import { configureLog } from './log.js';
import { listClaudeTranscripts, parseClaude } from './claude/transcript.js';
import { listCodexRollouts, parseCodex } from './codex/rollout.js';
import {
  installShim, installClaudeHooks, uninstallClaudeHooks, installCodexNotify, writeDefaultConfig,
  installAgent, uninstallAgent,
} from './install.js';

const HELP = `ai-sync — keep Claude Code and Codex chats in sync, both directions

Usage: ai-sync <command> [options]

  setup [--load]          write config, install hook shim, Claude hooks, Codex notify, login agent
  daemon                  run the sync daemon in the foreground
  sync [--dry-run] [--force] [--full] [--days N]
                          run one sync pass (via the daemon when it is running)
  status                  daemon state, recent runs, link counts
  links                   list paired conversations
  unlink <id> [--ignore]  drop a pairing; --ignore stops the origin from being re-mirrored
  pause | resume          pause/resume automatic syncing in the running daemon
  reload                  reload config in the running daemon
  stop                    stop the running daemon
  doctor                  check paths, parse every transcript, report problems
  install-hooks | uninstall-hooks | install-agent [--load] | uninstall-agent

Options: --state-dir DIR (default ~/.ai-sync, or $AI_SYNC_HOME)
`;

function args(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (['days', 'state-dir'].includes(k) && next !== undefined) { flags[k] = next; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function printStats(s: SyncStats, dry: boolean) {
  const { actions, ...rest } = s;
  for (const a of actions) console.log(`${dry ? '[dry-run] ' : ''}${a}`);
  console.log(JSON.stringify(rest));
}

async function main() {
  const { flags, pos } = args(process.argv.slice(2));
  const cmd = pos[0] ?? 'help';
  const cfg: Config = loadConfig(flags['state-dir'] ? { stateDir: String(flags['state-dir']) } : {});
  const sp = statePaths(cfg);

  switch (cmd) {
    case 'daemon': return runDaemon(cfg);

    case 'sync': {
      const req = { cmd: 'sync-now', dryRun: !!flags['dry-run'], force: !!flags.force, full: !!flags.full,
        backfillDays: flags.days !== undefined ? Number(flags.days) : undefined };
      const viaDaemon = await ctl(sp.sock, req);
      if (viaDaemon?.ok && viaDaemon.stats) return printStats(viaDaemon.stats, req.dryRun);
      if (viaDaemon?.queued) return console.log('daemon is mid-sync; queued another pass');
      configureLog({ quiet: true, file: sp.log });
      const ledger = new Ledger(sp.db);
      try {
        const s = await new SyncEngine(cfg, ledger).run({ trigger: 'cli', ...req });
        printStats(s, req.dryRun);
        if (s.errors) process.exitCode = 1;
      } finally { ledger.close(); }
      return;
    }

    case 'status': {
      const st = await ctl(sp.sock, { cmd: 'status' }, 3000);
      console.log(st?.ok ? `daemon: running (pid ${st.state.pid}${st.state.paused ? ', PAUSED' : ''})` : 'daemon: not running');
      if (st?.ok) console.log(JSON.stringify(st.state, null, 2));
      if (!fs.existsSync(sp.db)) return console.log('ledger: none yet');
      const l = new Ledger(sp.db);
      const links = l.links();
      const by = (k: string) => links.filter((x) => x.status === k).length;
      console.log(`links: ${links.length} (active ${by('active')}, paused ${by('paused')}, broken ${by('broken')})`);
      console.log(`pending writes: ${l.pending().length}`);
      for (const r of l.lastRuns(5)) console.log(`run ${r.id} ${r.started_at} ${r.trigger}${r.error ? ' ERROR' : ''} ${r.stats ?? ''}`.slice(0, 300));
      l.close();
      return;
    }

    case 'links': {
      const l = new Ledger(sp.db);
      for (const x of l.links()) {
        console.log(`${String(x.id).padStart(4)}  ${x.status.padEnd(7)} ${x.origin.padEnd(6)} ${x.how.padEnd(8)} claude:${x.claude_session_id}  codex:${x.codex_thread_id}  ${x.title}`);
        if (x.last_error) console.log(`      error: ${x.last_error}`);
      }
      l.close();
      return;
    }

    case 'unlink': {
      const id = Number(pos[1]);
      if (!id) throw new Error('usage: ai-sync unlink <id> [--ignore]');
      const l = new Ledger(sp.db);
      const link = l.link(id);
      if (!link) throw new Error(`no link ${id}`);
      l.tx(() => {
        l.deleteLink(id);
        const mirrorSide = link.origin === 'claude' ? 'codex' : 'claude';
        l.ignore(mirrorSide, mirrorSide === 'claude' ? link.claude_session_id : link.codex_thread_id, `mirror of unlinked ${id}`);
        if (flags.ignore) l.ignore(link.origin, link.origin === 'claude' ? link.claude_session_id : link.codex_thread_id, 'unlinked by user');
      });
      l.close();
      console.log(`unlinked ${id}. Mirror file left in place: ${link.origin === 'claude' ? link.codex_path : link.claude_path}`);
      return;
    }

    case 'pause': case 'resume': case 'reload': case 'stop': {
      const r = await ctl(sp.sock, { cmd }, 5000);
      console.log(r ? JSON.stringify(r) : 'daemon not running');
      return;
    }

    case 'doctor': return doctor(cfg);

    case 'install-hooks': return installHooks(cfg);
    case 'uninstall-hooks': {
      const shim = installShim(cfg);
      console.log(uninstallClaudeHooks(cfg, shim) ? 'claude hooks removed' : 'no claude hooks found');
      console.log('codex: remove the `notify` line for ai-sync-hook.sh from ~/.codex/config.toml if you added it');
      return;
    }
    case 'install-agent': console.log(`agent: ${installAgent(cfg, !!flags.load)}${flags.load ? ' (loaded)' : ' (run with --load to start it)'}`); return;
    case 'uninstall-agent': console.log(uninstallAgent() ?? 'no agent installed'); return;

    case 'setup': {
      const c = writeDefaultConfig(cfg);
      console.log(c ? `config: ${c}` : 'config: existing file kept');
      installHooks(cfg);
      console.log(`agent: ${installAgent(cfg, !!flags.load)}${flags.load ? ' (loaded)' : ' (run `ai-sync install-agent --load` to start it)'}`);
      console.log('\nNext: `ai-sync sync --dry-run` to preview what the first pass will do.');
      return;
    }

    default: console.log(HELP);
  }
}

function installHooks(cfg: Config) {
  const shim = installShim(cfg);
  console.log(`shim: ${shim}`);
  const ch = installClaudeHooks(cfg, shim);
  console.log(ch.length ? `claude hooks added: ${ch.join(', ')}` : 'claude hooks: already present');
  const cx = installCodexNotify(cfg, shim);
  if (typeof cx === 'string') console.log(`codex notify: ${cx}`);
  else console.log(`codex notify: an existing notify program is configured (${cx.conflict}).\n  ai-sync still syncs via file watching and the periodic pass. For instant Codex triggers,\n  call ${shim} "$1" from your existing notify script.`);
}

function doctor(cfg: Config) {
  const po = { includeTools: cfg.includeTools, maxToolChars: cfg.maxToolChars };
  const ok = (b: boolean, m: string) => console.log(`${b ? 'ok  ' : 'FAIL'} ${m}`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  ok(maj > 22 || (maj === 22 && min >= 13), `node ${process.versions.node} (need >= 22.13 for node:sqlite)`);
  ok(fs.existsSync(cfg.claudeDir), `claude dir ${cfg.claudeDir}`);
  ok(fs.existsSync(cfg.codexDir), `codex dir ${cfg.codexDir}`);
  const cf = listClaudeTranscripts(cfg.claudeDir);
  let cMsgs = 0, cEmpty = 0, cNoCwd = 0;
  for (const f of cf) { const p = parseClaude(f, po); if (!p?.messages.length) cEmpty++; else cMsgs += p.messages.length; if (p && !p.cwd) cNoCwd++; }
  console.log(`     claude transcripts: ${cf.length}, messages: ${cMsgs}, without messages: ${cEmpty}, without cwd: ${cNoCwd}`);
  const xf = listCodexRollouts(cfg.codexDir);
  let xMsgs = 0, xEmpty = 0, xNoMeta = 0;
  for (const f of xf) { const p = parseCodex(f, po); if (!p?.messages.length) xEmpty++; else xMsgs += p.messages.length; if (p && !p.meta) xNoMeta++; }
  console.log(`     codex rollouts: ${xf.length}, messages: ${xMsgs}, without messages: ${xEmpty}, without session_meta: ${xNoMeta}`);
  ok(xNoMeta === 0, 'every codex rollout has a session_meta header');
  const sp = statePaths(cfg);
  ok(fs.existsSync(`${sp.bin}/ai-sync-hook.sh`), 'hook shim installed');
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
