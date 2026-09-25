import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Side } from './model.js';

export const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per paired conversation. origin = the side where it was first seen natively.
CREATE TABLE IF NOT EXISTS links (
  id                INTEGER PRIMARY KEY,
  origin            TEXT NOT NULL CHECK (origin IN ('claude','codex')),
  claude_session_id TEXT NOT NULL UNIQUE,
  claude_path       TEXT NOT NULL UNIQUE,
  codex_thread_id   TEXT NOT NULL UNIQUE,
  codex_path        TEXT NOT NULL UNIQUE,
  cwd               TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','broken')),
  how               TEXT NOT NULL DEFAULT 'mirrored' CHECK (how IN ('mirrored','adopted')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_error        TEXT
);

-- Every message copied across. native_side is where the message was authored.
-- status 'pending' rows are write-ahead entries resolved by crash recovery.
CREATE TABLE IF NOT EXISTS message_map (
  link_id     INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  native_side TEXT NOT NULL CHECK (native_side IN ('claude','codex')),
  native_id   TEXT NOT NULL,
  mirror_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  run_id      INTEGER,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (link_id, native_side, native_id)
);
CREATE INDEX IF NOT EXISTS message_map_mirror ON message_map(link_id, mirror_id);

-- Cheap change detection so unchanged files are not re-parsed.
CREATE TABLE IF NOT EXISTS file_state (
  path      TEXT PRIMARY KEY,
  side      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  mtime_ms  REAL NOT NULL,
  seen_at   TEXT NOT NULL
);

-- Conversations deliberately not mirrored (unlinked by user, or too old/filtered).
CREATE TABLE IF NOT EXISTS ignored (
  side    TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  reason  TEXT NOT NULL,
  PRIMARY KEY (side, conv_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY,
  trigger     TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT,
  error       TEXT
);
`;

export interface LinkRow {
  id: number; origin: Side; claude_session_id: string; claude_path: string;
  codex_thread_id: string; codex_path: string; cwd: string; title: string;
  status: 'active' | 'paused' | 'broken'; how: 'mirrored' | 'adopted';
  created_at: string; updated_at: string; last_error: string | null;
}

const now = () => new Date().toISOString();

export class Ledger {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(DDL);
    const v = this.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as any;
    if (!v) this.db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)`).run(String(SCHEMA_VERSION));
    else if (Number(v.value) > SCHEMA_VERSION) throw new Error(`ledger schema ${v.value} is newer than this build (${SCHEMA_VERSION})`);
    if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* ignore */ } }
  }

  close() { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- links
  links(status?: LinkRow['status']): LinkRow[] {
    return (status
      ? this.db.prepare(`SELECT * FROM links WHERE status=? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM links ORDER BY id`).all()) as unknown as LinkRow[];
  }
  link(id: number): LinkRow | undefined {
    return this.db.prepare(`SELECT * FROM links WHERE id=?`).get(id) as unknown as LinkRow | undefined;
  }
  linkByConv(side: Side, convId: string): LinkRow | undefined {
    const col = side === 'claude' ? 'claude_session_id' : 'codex_thread_id';
    return this.db.prepare(`SELECT * FROM links WHERE ${col}=?`).get(convId) as unknown as LinkRow | undefined;
  }
  linkByPath(p: string): LinkRow | undefined {
    return this.db.prepare(`SELECT * FROM links WHERE claude_path=? OR codex_path=?`).get(p, p) as unknown as LinkRow | undefined;
  }
  insertLink(l: Omit<LinkRow, 'id' | 'created_at' | 'updated_at' | 'last_error' | 'status'>): number {
    const t = now();
    const r = this.db.prepare(`INSERT INTO links(origin,claude_session_id,claude_path,codex_thread_id,codex_path,cwd,title,how,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(l.origin, l.claude_session_id, l.claude_path, l.codex_thread_id, l.codex_path, l.cwd, l.title, l.how, t, t);
    return Number(r.lastInsertRowid);
  }
  setLinkStatus(id: number, status: LinkRow['status'], err: string | null = null) {
    this.db.prepare(`UPDATE links SET status=?, last_error=?, updated_at=? WHERE id=?`).run(status, err, now(), id);
  }
  touchLink(id: number) { this.db.prepare(`UPDATE links SET updated_at=?, last_error=NULL WHERE id=?`).run(now(), id); }
  deleteLink(id: number) { this.db.prepare(`DELETE FROM links WHERE id=?`).run(id); }

  // ---- message map
  mapped(linkId: number, nativeSide: Side): Map<string, { mirror_id: string; status: string }> {
    const rows = this.db.prepare(`SELECT native_id, mirror_id, status FROM message_map WHERE link_id=? AND native_side=?`).all(linkId, nativeSide) as any[];
    return new Map(rows.map((r) => [r.native_id, { mirror_id: r.mirror_id, status: r.status }]));
  }
  /** Ids (on `side`) that ai-sync wrote there as mirrors. */
  mirrorIdsOn(linkId: number, side: Side): Set<string> {
    const native = side === 'claude' ? 'codex' : 'claude';
    const rows = this.db.prepare(`SELECT mirror_id FROM message_map WHERE link_id=? AND native_side=?`).all(linkId, native) as any[];
    return new Set(rows.map((r) => r.mirror_id));
  }
  addPending(linkId: number, nativeSide: Side, pairs: { nativeId: string; mirrorId: string }[], runId: number | null) {
    const st = this.db.prepare(`INSERT OR REPLACE INTO message_map(link_id,native_side,native_id,mirror_id,status,run_id,created_at) VALUES(?,?,?,?, 'pending', ?, ?)`);
    const t = now();
    for (const p of pairs) st.run(linkId, nativeSide, p.nativeId, p.mirrorId, runId, t);
  }
  markDone(linkId: number, nativeSide: Side, nativeIds: string[]) {
    const st = this.db.prepare(`UPDATE message_map SET status='done' WHERE link_id=? AND native_side=? AND native_id=?`);
    for (const id of nativeIds) st.run(linkId, nativeSide, id);
  }
  dropPending(linkId: number, nativeSide: Side, nativeIds: string[]) {
    const st = this.db.prepare(`DELETE FROM message_map WHERE link_id=? AND native_side=? AND native_id=? AND status='pending'`);
    for (const id of nativeIds) st.run(linkId, nativeSide, id);
  }
  pending(): { link_id: number; native_side: Side; native_id: string; mirror_id: string }[] {
    return this.db.prepare(`SELECT link_id,native_side,native_id,mirror_id FROM message_map WHERE status='pending'`).all() as any[];
  }
  countMapped(linkId: number): number {
    return (this.db.prepare(`SELECT count(*) c FROM message_map WHERE link_id=? AND status='done'`).get(linkId) as any).c;
  }

  // ---- file state
  fileUnchanged(p: string, size: number, mtimeMs: number): boolean {
    const r = this.db.prepare(`SELECT size, mtime_ms FROM file_state WHERE path=?`).get(p) as any;
    return !!r && r.size === size && r.mtime_ms === mtimeMs;
  }
  recordFile(p: string, side: Side, size: number, mtimeMs: number) {
    this.db.prepare(`INSERT INTO file_state(path,side,size,mtime_ms,seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, seen_at=excluded.seen_at`).run(p, side, size, mtimeMs, now());
  }
  forgetFiles() { this.db.exec(`DELETE FROM file_state`); }

  // ---- ignored
  isIgnored(side: Side, convId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ignored WHERE side=? AND conv_id=?`).get(side, convId);
  }
  ignore(side: Side, convId: string, reason: string) {
    this.db.prepare(`INSERT OR REPLACE INTO ignored(side,conv_id,reason) VALUES(?,?,?)`).run(side, convId, reason);
  }
  unignore(side: Side, convId: string) { this.db.prepare(`DELETE FROM ignored WHERE side=? AND conv_id=?`).run(side, convId); }

  // ---- runs
  startRun(trigger: string, dryRun: boolean): number {
    return Number(this.db.prepare(`INSERT INTO sync_runs(trigger,dry_run,started_at) VALUES(?,?,?)`).run(trigger, dryRun ? 1 : 0, now()).lastInsertRowid);
  }
  finishRun(id: number, stats: unknown, error: string | null) {
    this.db.prepare(`UPDATE sync_runs SET finished_at=?, stats=?, error=? WHERE id=?`).run(now(), JSON.stringify(stats), error, id);
  }
  lastRuns(n = 5): any[] {
    return this.db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?`).all(n) as any[];
  }
}
