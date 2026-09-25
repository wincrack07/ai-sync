import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonMsg, Conversation } from '../model.js';
import { readJsonl, walk, sha, uuid, appendJsonl, truncate, firstLine } from '../util.js';
import type { ParseOpts } from '../claude/transcript.js';

export interface CodexParsed extends Conversation {
  side: 'codex';
  /** session_meta payload, used as a template for mirrors. */
  meta: Record<string, any> | null;
  /** Occurrence counts per base hash, so ids for appended lines can be predicted. */
  baseCounts: Map<string, number>;
}

const NOISE_PREFIXES = [
  '<environment_context>', '<user_instructions>', '<INSTRUCTIONS>', '# AGENTS.md instructions',
  '<permissions instructions>', '<user_shell_command>', '<turn_aborted>',
];

export function listCodexRollouts(codexDir: string): string[] {
  return walk(path.join(codexDir, 'sessions'), (p) => path.basename(p).startsWith('rollout-') && p.endsWith('.jsonl'), 4);
}

/** Thread id from the filename: rollout-<timestamp>-<uuid>.jsonl */
export function threadIdFromName(file: string): string | null {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : null;
}

/** Codex messages have no ids, so derive one from content + timestamp + occurrence number. */
export const codexBase = (role: string, kind: string, text: string, ts: string) => sha(`${role}|${kind}|${ts}|${text}`);

export function assignCodexIds<T extends { role: string; kind: string; text: string; timestamp: string }>(
  msgs: T[], counts: Map<string, number>,
): string[] {
  return msgs.map((m) => {
    const b = codexBase(m.role, m.kind, m.text, m.timestamp);
    const n = counts.get(b) ?? 0;
    counts.set(b, n + 1);
    return `${b}:${n}`;
  });
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string')
    .map((c: any) => c.text).join('\n\n');
}

function toolText(p: any, max: number): string | null {
  switch (p?.type) {
    case 'function_call': return `▸ ${p.name ?? 'function'}: ${truncate(String(p.arguments ?? ''), max)}`;
    case 'custom_tool_call': return `▸ ${p.name ?? 'tool'}: ${truncate(String(p.input ?? ''), max)}`;
    case 'local_shell_call': {
      const cmd = p.action?.command;
      return `▸ shell: ${truncate(Array.isArray(cmd) ? cmd.join(' ') : JSON.stringify(p.action ?? {}), max)}`;
    }
    case 'web_search_call': return `▸ web_search: ${truncate(JSON.stringify(p.action ?? {}), max)}`;
    default: return null;
  }
}

export function parseCodex(file: string, opts: ParseOpts): CodexParsed | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const lines = readJsonl(file);
  let meta: Record<string, any> | null = null;
  let id = threadIdFromName(file) ?? '';
  let cwd = '';
  const raw: Omit<CanonMsg, 'id'>[] = [];

  for (const { obj: o } of lines) {
    if (!o || typeof o !== 'object') continue;
    let item: any;
    const ts: string = typeof o.timestamp === 'string' ? o.timestamp : '';
    if (o.type === 'session_meta') {
      meta = o.payload ?? {};
      if (meta!.id) id = String(meta!.id);
      if (meta!.cwd) cwd = String(meta!.cwd);
      continue;
    } else if (o.type === 'turn_context') {
      if (!cwd && o.payload?.cwd) cwd = String(o.payload.cwd);
      continue;
    } else if (o.type === 'response_item') {
      item = o.payload;
    } else if (o.type === 'event_msg' || o.type === 'compacted') {
      continue;
    } else if (!o.type && o.id && o.timestamp && !meta) {
      meta = o; id = String(o.id); continue; // legacy header line
    } else if (o.type === 'message' || o.type === 'function_call' || o.type === 'local_shell_call' || o.type === 'custom_tool_call') {
      item = o; // legacy: items written directly
    } else continue;

    if (item?.type === 'message') {
      if (item.role !== 'user' && item.role !== 'assistant') continue;
      const text = textOf(item.content).trim();
      if (!text) continue;
      if (item.role === 'user' && NOISE_PREFIXES.some((p) => text.startsWith(p))) continue;
      raw.push({ role: item.role, text, timestamp: ts, kind: 'text' });
    } else if (opts.includeTools === 'summary') {
      const t = toolText(item, opts.maxToolChars);
      if (t) raw.push({ role: 'assistant', text: t, timestamp: ts, kind: 'tool' });
    }
  }

  const baseCounts = new Map<string, number>();
  const ids = assignCodexIds(raw, baseCounts);
  const messages: CanonMsg[] = raw.map((m, i) => ({ ...m, id: ids[i] }));
  const firstUser = messages.find((m) => m.role === 'user')?.text ?? '';
  return {
    side: 'codex', path: file, id, cwd, title: truncate(firstLine(firstUser), 80),
    messages, mtimeMs: st.mtimeMs, size: st.size, meta, baseCounts,
  };
}

// ---------------------------------------------------------------- writer (CodexImporterPort default impl)

export interface CodexTarget { path: string; threadId: string; baseCounts: Map<string, number>; }
export interface PlannedCodexLine { codexId: string; msg: CanonMsg; timestamp: string; }

export function planCodexLines(target: CodexTarget, msgs: CanonMsg[]): PlannedCodexLine[] {
  const counts = new Map(target.baseCounts);
  // Tool summaries become ordinary assistant text on the Codex side.
  const shaped = msgs.map((m) => ({ role: m.role, kind: 'text', text: m.text, timestamp: m.timestamp || new Date().toISOString() }));
  const ids = assignCodexIds(shaped, counts);
  return msgs.map((m, i) => ({ codexId: ids[i], msg: m, timestamp: shaped[i].timestamp }));
}

export function buildCodexLines(planned: PlannedCodexLine[], writeEventMsgs: boolean): any[] {
  const out: any[] = [];
  for (const { msg, timestamp } of planned) {
    const ctype = msg.role === 'user' ? 'input_text' : 'output_text';
    out.push({ timestamp, type: 'response_item', payload: { type: 'message', role: msg.role, content: [{ type: ctype, text: msg.text }] } });
    if (writeEventMsgs) {
      out.push({ timestamp, type: 'event_msg', payload: msg.role === 'user'
        ? { type: 'user_message', message: msg.text, images: [] }
        : { type: 'agent_message', message: msg.text } });
    }
  }
  return out;
}

export function appendCodex(target: CodexTarget, planned: PlannedCodexLine[], writeEventMsgs: boolean): void {
  appendJsonl(target.path, buildCodexLines(planned, writeEventMsgs));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Create a new rollout file with a session_meta header modelled on the newest real rollout. */
export function createCodexRollout(
  codexDir: string, cwd: string, startedAt: string, template: Record<string, any> | null,
  existing?: { threadId: string; file: string },
): CodexTarget {
  const threadId = existing?.threadId ?? uuid();
  const d = new Date(startedAt || Date.now());
  const date = isNaN(d.getTime()) ? new Date() : d;
  const dir = path.join(codexDir, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const file = existing?.file ?? path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
  const iso = date.toISOString();
  const { git: _git, instructions: _i, base_instructions: _b, ...rest } = template ?? {};
  const payload = {
    originator: 'codex_cli_rs', cli_version: '0.0.0', source: 'cli', model_provider: 'openai',
    ...rest, id: threadId, timestamp: iso, cwd: cwd || '/', instructions: null,
  };
  appendJsonl(file, [{ timestamp: iso, type: 'session_meta', payload }]);
  return { path: file, threadId, baseCounts: new Map() };
}

export function findCodexTemplate(files: string[]): Record<string, any> | null {
  const sorted = files.map((f) => { try { return [f, fs.statSync(f).mtimeMs] as const; } catch { return [f, 0] as const; } })
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [f] of sorted) {
    const first = readJsonl(f)[0]?.obj;
    if (first?.type === 'session_meta' && first.payload) return first.payload;
  }
  return null;
}
