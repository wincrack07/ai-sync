import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { Config } from './config.js';
import { cwdAllowed } from './config.js';
import type { Ledger, LinkRow } from './ledger.js';
import type { CanonMsg, Side } from './model.js';
import { log } from './log.js';
import { normalizeText, readJsonl, sha, truncate } from './util.js';
import {
  parseClaude, listClaudeTranscripts, planClaudeRecords, appendClaude, writeClaudeTitle,
  newClaudeTarget, findClaudeTemplate, type ClaudeParsed, type ClaudeTarget,
} from './claude/transcript.js';
import {
  parseCodex, listCodexRollouts, planCodexLines, appendCodex, createCodexRollout,
  findCodexTemplate, type CodexParsed, type CodexTarget,
} from './codex/rollout.js';

export interface SyncOptions {
  trigger: string;
  dryRun?: boolean;
  /** Ignore the quiescence window (write even into recently-modified files). */
  force?: boolean;
  /** Re-parse every linked file even if size/mtime are unchanged. */
  full?: boolean;
  /** Override cfg.backfillDays for discovery in this run. */
  backfillDays?: number;
}

export interface SyncStats {
  runId: number | null;
  scanned: { claude: number; codex: number };
  created: { claude: number; codex: number };
  adopted: number;
  repointed: number;
  appended: { toClaude: number; toCodex: number };
  deduped: number;
  busy: number;
  conflicts: number;
  errors: number;
  recovered: number;
  actions: string[];
}

const newStats = (): SyncStats => ({
  runId: null, scanned: { claude: 0, codex: 0 }, created: { claude: 0, codex: 0 }, adopted: 0, repointed: 0,
  appended: { toClaude: 0, toCodex: 0 }, deduped: 0, busy: 0, conflicts: 0, errors: 0, recovered: 0, actions: [],
});

/** Messages with the same role, text and second are the same message, whatever ids they carry. */
const echoKey = (m: CanonMsg) => `${m.role}|${m.timestamp.slice(0, 19)}|${sha(normalizeText(m.text))}`;
const firstUserKey = (msgs: CanonMsg[]) => {
  const u = msgs.find((m) => m.role === 'user' && m.kind === 'text');
  return u ? sha(normalizeText(u.text)) : null;
};

export class SyncEngine {
  private running = false;
  constructor(readonly cfg: Config, readonly ledger: Ledger) {}

  private parseOpts() { return { includeTools: this.cfg.includeTools, maxToolChars: this.cfg.maxToolChars }; }

  private busy(file: string, opts: SyncOptions): boolean {
    if (opts.force) return false;
    try {
      const st = fs.statSync(file);
      // Our own last write does not count as activity.
      if (this.ledger.fileUnchanged(file, st.size, st.mtimeMs)) return false;
      return Date.now() - st.mtimeMs < this.cfg.quiescenceSec * 1000;
    } catch { return false; }
  }

  /** Resolve write-ahead rows left behind by a crash between ledger insert and file write. */
  recover(stats: SyncStats = newStats()): SyncStats {
    const pending = this.ledger.pending();
    if (!pending.length) return stats;
    const byLink = new Map<string, typeof pending>();
    for (const p of pending) {
      const k = `${p.link_id}|${p.native_side}`;
      if (!byLink.has(k)) byLink.set(k, []);
      byLink.get(k)!.push(p);
    }
    for (const rows of byLink.values()) {
      const link = this.ledger.link(rows[0].link_id);
      if (!link) continue;
      const nativeSide = rows[0].native_side;
      let present: Set<string>;
      if (nativeSide === 'codex') {
        present = new Set(readJsonl(link.claude_path).map((l) => l.obj?.uuid).filter(Boolean));
      } else {
        present = new Set(parseCodex(link.codex_path, this.parseOpts())?.messages.map((m) => m.id) ?? []);
      }
      const done = rows.filter((r) => present.has(r.mirror_id)).map((r) => r.native_id);
      const gone = rows.filter((r) => !present.has(r.mirror_id)).map((r) => r.native_id);
      this.ledger.tx(() => {
        this.ledger.markDone(link.id, nativeSide, done);
        this.ledger.dropPending(link.id, nativeSide, gone);
      });
      stats.recovered += rows.length;
      log.info('recovered pending writes', { link: link.id, nativeSide, confirmed: done.length, dropped: gone.length });
    }
    return stats;
  }

  async run(opts: SyncOptions): Promise<SyncStats> {
    if (this.running) throw new Error('sync already running');
    this.running = true;
    const stats = newStats();
    const runId = opts.dryRun ? null : this.ledger.startRun(opts.trigger, false);
    stats.runId = runId;
    let error: string | null = null;
    try {
      if (!opts.dryRun) this.recover(stats);
      await this.pass(opts, stats);
    } catch (e: any) {
      error = String(e?.stack ?? e);
      stats.errors++;
      log.error('sync failed', { error });
    } finally {
      this.running = false;
      if (runId !== null) this.ledger.finishRun(runId, { ...stats, actions: stats.actions.slice(0, 200) }, error);
    }
    return stats;
  }

  private async pass(opts: SyncOptions, stats: SyncStats) {
    const po = this.parseOpts();
    const claudeFiles = listClaudeTranscripts(this.cfg.claudeDir);
    const codexFiles = listCodexRollouts(this.cfg.codexDir);
    stats.scanned = { claude: claudeFiles.length, codex: codexFiles.length };

    // ---- 1. linked conversations
    const linkedPaths = new Set<string>();
    for (const link of this.ledger.links()) {
      linkedPaths.add(link.claude_path); linkedPaths.add(link.codex_path);
      if (link.status !== 'active') continue;
      try { this.syncLink(link, opts, stats); }
      catch (e: any) {
        stats.errors++;
        log.error('link sync failed', { link: link.id, error: String(e?.message ?? e) });
        if (!opts.dryRun) this.ledger.setLinkStatus(link.id, 'active', String(e?.message ?? e));
      }
    }

    // ---- 2. discovery of unlinked conversations
    const days = opts.backfillDays ?? this.cfg.backfillDays;
    const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
    const fresh = (f: string) => { try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; } };

    const claudeCands: ClaudeParsed[] = [];
    for (const f of claudeFiles) {
      if (linkedPaths.has(f) || !fresh(f)) continue;
      const c = parseClaude(f, po);
      if (!c || !c.messages.length || this.ledger.isIgnored('claude', c.id) || !cwdAllowed(this.cfg, c.cwd)) continue;
      claudeCands.push(c);
    }
    const codexCands: CodexParsed[] = [];
    for (const f of codexFiles) {
      if (linkedPaths.has(f) || !fresh(f)) continue;
      const c = parseCodex(f, po);
      if (!c || !c.messages.length || this.ledger.isIgnored('codex', c.id) || !cwdAllowed(this.cfg, c.cwd)) continue;
      codexCands.push(c);
    }

    // 2a. continuations/forks of already-linked conversations
    const remainingClaude = claudeCands.filter((c) => !this.tryRepoint(c, opts, stats));
    const remainingCodex = codexCands.filter((c) => !this.tryRepoint(c, opts, stats));

    // 2b. adopt pairs that already exist on both sides (native import, or a lost ledger)
    const codexByKey = new Map<string, CodexParsed>();
    for (const c of remainingCodex) { const k = firstUserKey(c.messages); if (k && !codexByKey.has(k)) codexByKey.set(k, c); }
    const adoptedCodex = new Set<string>();
    const unpairedClaude: ClaudeParsed[] = [];
    for (const c of remainingClaude) {
      const k = firstUserKey(c.messages);
      const x = k ? codexByKey.get(k) : undefined;
      if (x && !adoptedCodex.has(x.path)) { adoptedCodex.add(x.path); this.adopt(c, x, opts, stats); }
      else unpairedClaude.push(c);
    }

    // 2c. create mirrors
    let claudeTemplate: Record<string, unknown> | null = null;
    let codexTemplate: Record<string, any> | null | undefined;
    if (this.cfg.claudeToCodex) {
      for (const c of unpairedClaude) {
        if (c.allMirrored) { if (!opts.dryRun) this.ledger.ignore('claude', c.id, 'orphan-mirror'); continue; }
        if (!c.messages.some((m) => m.role === 'user')) continue;
        if (this.busy(c.path, opts)) { stats.busy++; continue; }
        if (codexTemplate === undefined) codexTemplate = findCodexTemplate(codexFiles);
        this.mirrorClaudeToCodex(c, codexTemplate, opts, stats);
      }
    }
    if (this.cfg.codexToClaude) {
      for (const x of remainingCodex) {
        if (adoptedCodex.has(x.path)) continue;
        if (!x.messages.some((m) => m.role === 'user')) continue;
        if (this.busy(x.path, opts)) { stats.busy++; continue; }
        if (claudeTemplate === null) claudeTemplate = findClaudeTemplate(claudeFiles);
        this.mirrorCodexToClaude(x, claudeTemplate, opts, stats);
      }
    }
  }

  // ------------------------------------------------------------ per-link reconcile

  private syncLink(link: LinkRow, opts: SyncOptions, stats: SyncStats) {
    const cst = statOrNull(link.claude_path), xst = statOrNull(link.codex_path);
    const originPath = link.origin === 'claude' ? link.claude_path : link.codex_path;
    if (!statOrNull(originPath)) {
      stats.actions.push(`link ${link.id}: origin file missing, marking broken`);
      if (!opts.dryRun) this.ledger.setLinkStatus(link.id, 'broken', `origin file missing: ${originPath}`);
      return;
    }
    const doneCount = this.ledger.countMapped(link.id);
    if ((!cst || !xst) && doneCount > 0) {
      stats.actions.push(`link ${link.id}: mirror file deleted, marking broken`);
      if (!opts.dryRun) this.ledger.setLinkStatus(link.id, 'broken', 'mirror file deleted; run `ai-sync unlink <id>` to re-mirror');
      return;
    }
    const unchanged = cst && xst && !opts.full
      && this.ledger.fileUnchanged(link.claude_path, cst.size, cst.mtimeMs)
      && this.ledger.fileUnchanged(link.codex_path, xst.size, xst.mtimeMs);
    if (unchanged) return;

    const po = this.parseOpts();
    const claude = cst ? parseClaude(link.claude_path, po) : null;
    const codex = xst ? parseCodex(link.codex_path, po) : null;

    const claudeMirrorIds = this.ledger.mirrorIdsOn(link.id, 'claude');
    const codexMirrorIds = this.ledger.mirrorIdsOn(link.id, 'codex');
    const mappedFromClaude = this.ledger.mapped(link.id, 'claude');
    const mappedFromCodex = this.ledger.mapped(link.id, 'codex');

    const claudeMsgs = claude?.messages ?? [];
    const codexMsgs = codex?.messages ?? [];
    const claudeNative = claudeMsgs.filter((m) => !m.mirrorOf && !claudeMirrorIds.has(m.id));
    const codexNative = codexMsgs.filter((m) => !codexMirrorIds.has(m.id));

    let toCodex = this.cfg.claudeToCodex ? claudeNative.filter((m) => !mappedFromClaude.has(m.id)) : [];
    let toClaude = this.cfg.codexToClaude ? codexNative.filter((m) => !mappedFromCodex.has(m.id)) : [];

    // Echo guard: never copy a message the destination already has (same role, text and second).
    const dedupe = (msgs: CanonMsg[], dest: CanonMsg[], nativeSide: Side) => {
      const destKeys = new Map(dest.map((m) => [echoKey(m), m.id]));
      const keep: CanonMsg[] = [], dup: { nativeId: string; mirrorId: string }[] = [];
      for (const m of msgs) {
        const hit = destKeys.get(echoKey(m));
        if (hit) dup.push({ nativeId: m.id, mirrorId: hit }); else keep.push(m);
      }
      if (dup.length) {
        stats.deduped += dup.length;
        if (!opts.dryRun) this.ledger.tx(() => {
          this.ledger.addPending(link.id, nativeSide, dup, stats.runId);
          this.ledger.markDone(link.id, nativeSide, dup.map((d) => d.nativeId));
        });
      }
      return keep;
    };
    toCodex = dedupe(toCodex, codexMsgs, 'claude');
    toClaude = dedupe(toClaude, claudeMsgs, 'codex');

    if (toCodex.length && toClaude.length) {
      stats.conflicts++;
      log.warn('both sides advanced since last sync; appending each to the other', { link: link.id, toCodex: toCodex.length, toClaude: toClaude.length });
    }

    let wroteAll = true;
    if (toCodex.length) {
      if (this.busy(link.codex_path, opts)) { stats.busy++; wroteAll = false; }
      else {
        const target: CodexTarget = codex
          ? { path: link.codex_path, threadId: link.codex_thread_id, baseCounts: codex.baseCounts }
          : this.recreateCodex(link, claude, opts);
        this.writeToCodex(link.id, target, toCodex, opts, stats);
      }
    }
    if (toClaude.length) {
      if (this.busy(link.claude_path, opts)) { stats.busy++; wroteAll = false; }
      else {
        const target: ClaudeTarget = {
          path: link.claude_path, sessionId: link.claude_session_id, cwd: claude?.cwd || link.cwd,
          leafUuid: claude?.leafUuid ?? null, template: claude?.template ?? {},
        };
        if (!claude && !opts.dryRun) writeClaudeTitle(link.claude_path, link.claude_session_id, this.cfg.titlePrefix.fromCodex + link.title);
        this.writeToClaude(link.id, target, toClaude, opts, stats);
      }
    }

    if (!opts.dryRun && wroteAll) {
      for (const p of [link.claude_path, link.codex_path]) {
        const s = statOrNull(p);
        if (s) this.ledger.recordFile(p, p === link.claude_path ? 'claude' : 'codex', s.size, s.mtimeMs);
      }
      if (toCodex.length || toClaude.length) this.ledger.touchLink(link.id);
    }
  }

  private recreateCodex(link: LinkRow, claude: ClaudeParsed | null, opts: SyncOptions): CodexTarget {
    // Link row exists but the mirror file was never written (crash before first write).
    if (opts.dryRun) return { path: link.codex_path, threadId: link.codex_thread_id, baseCounts: new Map() };
    const t = createCodexRollout(this.cfg.codexDir, claude?.cwd || link.cwd, claude?.messages[0]?.timestamp ?? '', null,
      { threadId: link.codex_thread_id, file: link.codex_path });
    return t;
  }

  private writeToCodex(linkId: number, target: CodexTarget, msgs: CanonMsg[], opts: SyncOptions, stats: SyncStats) {
    const planned = planCodexLines(target, msgs);
    stats.actions.push(`link ${linkId}: +${msgs.length} → codex ${target.threadId}`);
    if (opts.dryRun) return;
    this.ledger.tx(() => this.ledger.addPending(linkId, 'claude', planned.map((p) => ({ nativeId: p.msg.id, mirrorId: p.codexId })), stats.runId));
    appendCodex(target, planned, this.cfg.codex.writeEventMsgs);
    this.ledger.tx(() => this.ledger.markDone(linkId, 'claude', planned.map((p) => p.msg.id)));
    stats.appended.toCodex += msgs.length;
  }

  private writeToClaude(linkId: number, target: ClaudeTarget, msgs: CanonMsg[], opts: SyncOptions, stats: SyncStats) {
    target.model = this.cfg.claudeMirrorModel;
    const planned = planClaudeRecords(msgs);
    stats.actions.push(`link ${linkId}: +${msgs.length} → claude ${target.sessionId}`);
    if (opts.dryRun) return;
    this.ledger.tx(() => this.ledger.addPending(linkId, 'codex', planned.map((p) => ({ nativeId: p.msg.id, mirrorId: p.uuid })), stats.runId));
    appendClaude(target, planned);
    this.ledger.tx(() => this.ledger.markDone(linkId, 'codex', planned.map((p) => p.msg.id)));
    stats.appended.toClaude += msgs.length;
  }

  // ------------------------------------------------------------ discovery actions

  private mirrorClaudeToCodex(c: ClaudeParsed, template: Record<string, any> | null, opts: SyncOptions, stats: SyncStats) {
    const msgs = c.messages.filter((m) => !m.mirrorOf);
    stats.actions.push(`new codex mirror for claude ${c.id} "${truncate(c.title, 50)}" (${msgs.length} msgs)`);
    if (opts.dryRun) { stats.created.codex++; return; }
    const target = createCodexRollout(this.cfg.codexDir, c.cwd, msgs[0]?.timestamp ?? '', template);
    const linkId = this.ledger.insertLink({
      origin: 'claude', claude_session_id: c.id, claude_path: c.path, codex_thread_id: target.threadId,
      codex_path: target.path, cwd: c.cwd, title: c.title, how: 'mirrored',
    });
    this.writeToCodex(linkId, target, msgs, opts, stats);
    this.recordBoth(c.path, 'claude', target.path, 'codex');
    stats.created.codex++;
    this.postCreate(target.path, target.threadId);
  }

  private mirrorCodexToClaude(x: CodexParsed, template: Record<string, unknown>, opts: SyncOptions, stats: SyncStats) {
    stats.actions.push(`new claude mirror for codex ${x.id} "${truncate(x.title, 50)}" (${x.messages.length} msgs)`);
    if (opts.dryRun) { stats.created.claude++; return; }
    const target = newClaudeTarget(this.cfg.claudeDir, x.cwd, template);
    const linkId = this.ledger.insertLink({
      origin: 'codex', claude_session_id: target.sessionId, claude_path: target.path, codex_thread_id: x.id,
      codex_path: x.path, cwd: x.cwd, title: x.title, how: 'mirrored',
    });
    writeClaudeTitle(target.path, target.sessionId, this.cfg.titlePrefix.fromCodex + x.title);
    this.writeToClaude(linkId, target, x.messages, opts, stats);
    this.recordBoth(target.path, 'claude', x.path, 'codex');
    stats.created.claude++;
  }

  /**
   * Pair two conversations that already hold the same history. Everything up to the last
   * message both sides share becomes a baseline; only later messages are synced.
   */
  private adopt(c: ClaudeParsed, x: CodexParsed, opts: SyncOptions, stats: SyncStats) {
    stats.actions.push(`adopt claude ${c.id} ⇄ codex ${x.id} "${truncate(c.title, 50)}"`);
    stats.adopted++;
    if (opts.dryRun) return;
    const norm = (m: CanonMsg) => `${m.role}|${normalizeText(m.text)}`;
    let j = 0, lastC = -1, lastX = -1;
    const pairs: [CanonMsg, CanonMsg][] = [];
    for (let i = 0; i < c.messages.length && j < x.messages.length; i++) {
      const k = norm(c.messages[i]);
      for (let jj = j; jj < x.messages.length; jj++) {
        if (norm(x.messages[jj]) === k) { pairs.push([c.messages[i], x.messages[jj]]); lastC = i; lastX = jj; j = jj + 1; break; }
      }
    }
    const origin: Side = (c.messages[0]?.timestamp || '9') <= (x.messages[0]?.timestamp || '9') ? 'claude' : 'codex';
    this.ledger.tx(() => {
      const linkId = this.ledger.insertLink({
        origin, claude_session_id: c.id, claude_path: c.path, codex_thread_id: x.id, codex_path: x.path,
        cwd: c.cwd || x.cwd, title: c.title, how: 'adopted',
      });
      const paired = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
      const claudeRows = pairs.map(([a, b]) => ({ nativeId: a.id, mirrorId: b.id }));
      for (let i = 0; i <= lastC; i++) if (!paired.has(c.messages[i].id)) claudeRows.push({ nativeId: c.messages[i].id, mirrorId: `baseline:${c.messages[i].id}` });
      const codexRows = [] as { nativeId: string; mirrorId: string }[];
      for (let i = 0; i <= lastX; i++) if (!paired.has(x.messages[i].id)) codexRows.push({ nativeId: x.messages[i].id, mirrorId: `baseline:${x.messages[i].id}` });
      this.ledger.addPending(linkId, 'claude', claudeRows, stats.runId);
      this.ledger.markDone(linkId, 'claude', claudeRows.map((r) => r.nativeId));
      this.ledger.addPending(linkId, 'codex', codexRows, stats.runId);
      this.ledger.markDone(linkId, 'codex', codexRows.map((r) => r.nativeId));
    });
    // Leave file_state unrecorded so the new link is reconciled on the next pass.
  }

  /**
   * A new file that carries messages the ledger already knows about is a continuation
   * (resume/fork) of a linked conversation. Point the link at the newer file.
   */
  private tryRepoint(conv: ClaudeParsed | CodexParsed, opts: SyncOptions, stats: SyncStats): boolean {
    const ids = conv.messages.map((m) => m.id);
    const markers = conv.messages.map((m) => m.mirrorOf).filter(Boolean) as string[];
    if (!ids.length) return false;
    const q = (sql: string, vals: string[]) => {
      if (!vals.length) return [] as number[];
      const rows = this.ledger.db.prepare(sql.replace('?LIST', vals.map(() => '?').join(','))).all(...vals) as any[];
      return rows.map((r) => r.link_id as number);
    };
    const hits = new Map<number, number>();
    const bump = (arr: number[]) => arr.forEach((l) => hits.set(l, (hits.get(l) ?? 0) + 1));
    bump(q(`SELECT link_id FROM message_map WHERE native_side='${conv.side}' AND native_id IN (?LIST)`, ids));
    bump(q(`SELECT link_id FROM message_map WHERE native_side!='${conv.side}' AND mirror_id IN (?LIST)`, ids));
    if (conv.side === 'claude') bump(q(`SELECT link_id FROM message_map WHERE native_side='codex' AND native_id IN (?LIST)`, markers));
    const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < Math.min(2, ids.length)) return false;
    const link = this.ledger.link(best[0]);
    if (!link) return false;
    const oldPath = conv.side === 'claude' ? link.claude_path : link.codex_path;
    const oldM = statOrNull(oldPath)?.mtimeMs ?? 0;
    if (conv.mtimeMs <= oldM) {
      if (!opts.dryRun) this.ledger.ignore(conv.side, conv.id, `stale copy of link ${link.id}`);
      return true;
    }
    stats.repointed++;
    stats.actions.push(`link ${link.id}: ${conv.side} continued in ${conv.id}, repointing`);
    if (opts.dryRun) return true;
    const oldId = conv.side === 'claude' ? link.claude_session_id : link.codex_thread_id;
    const col = conv.side === 'claude' ? ['claude_session_id', 'claude_path'] : ['codex_thread_id', 'codex_path'];
    this.ledger.tx(() => {
      this.ledger.db.prepare(`UPDATE links SET ${col[0]}=?, ${col[1]}=?, updated_at=? WHERE id=?`).run(conv.id, conv.path, new Date().toISOString(), link.id);
      this.ledger.ignore(conv.side, oldId, `superseded by ${conv.id}`);
    });
    return true;
  }

  private recordBoth(a: string, as: Side, b: string, bs: Side) {
    for (const [p, s] of [[a, as], [b, bs]] as const) {
      const st = statOrNull(p);
      if (st) this.ledger.recordFile(p, s, st.size, st.mtimeMs);
    }
  }

  private postCreate(file: string, id: string) {
    const cmd = this.cfg.codex.postCreateCommand;
    if (!cmd) return;
    const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    execFile('/bin/sh', ['-c', cmd.replaceAll('{path}', sh(file)).replaceAll('{id}', sh(id))], (err) => {
      if (err) log.warn('postCreateCommand failed', { error: String(err.message) });
    });
  }
}

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}
