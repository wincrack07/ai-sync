import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const sha = (s: string, n = 24) => createHash('sha256').update(s).digest('hex').slice(0, n);
export const uuid = () => randomUUID();

export interface JsonlLine { index: number; obj: any; }

/** Read a JSONL file. Unparseable lines (e.g. a partially written last line) are skipped. */
export function readJsonl(file: string): JsonlLine[] {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: JsonlLine[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try { out.push({ index: i, obj: JSON.parse(l) }); } catch { /* partial or corrupt line */ }
  }
  return out;
}

/**
 * Append whole JSON lines in a single write with O_APPEND, so concurrent writers
 * never see a torn record. Adds a leading newline if the file does not end in one.
 */
export function appendJsonl(file: string, objs: unknown[]): void {
  if (!objs.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, st.size - 1);
      fs.closeSync(fd);
      if (b.toString() !== '\n') prefix = '\n';
    }
  } catch { /* new file */ }
  const data = prefix + objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Write a whole file atomically (temp + rename). */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function walk(dir: string, pred: (p: string) => boolean, maxDepth = 6): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) rec(p, depth + 1); }
      else if (e.isFile() && pred(p)) out.push(p);
    }
  };
  rec(dir, 0);
  return out;
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
export const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();
