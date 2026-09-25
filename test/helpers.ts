import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { SyncEngine } from '../src/engine.js';
import { configureLog } from '../src/log.js';

configureLog({ quiet: true, file: null });

export interface Sandbox { root: string; cfg: Config; ledger: Ledger; engine: SyncEngine; cleanup: () => void; }

export function sandbox(over: Partial<Config> = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sync-test-'));
  const cfg = loadConfig({
    claudeDir: path.join(root, 'claude'), codexDir: path.join(root, 'codex'), stateDir: path.join(root, 'state'),
    quiescenceSec: 0, backfillDays: 0, watch: false, ...over,
  });
  fs.mkdirSync(path.join(cfg.claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(cfg.codexDir, 'sessions'), { recursive: true });
  const ledger = new Ledger(path.join(cfg.stateDir, 'ledger.sqlite'));
  return { root, cfg, ledger, engine: new SyncEngine(cfg, ledger), cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

export const writeLines = (file: string, objs: unknown[], append = false) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
};
export const readLines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Realistic Claude Code transcript builder. */
export class ClaudeFixture {
  sessionId = randomUUID();
  leaf: string | null = null;
  file: string;
  t = Date.parse('2026-09-20T10:00:00Z');
  constructor(claudeDir: string, readonly cwd = '/Users/me/proj') {
    this.file = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${this.sessionId}.jsonl`);
  }
  private base(type: string, extra: object) {
    const uuid = randomUUID();
    const rec = { parentUuid: this.leaf, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: this.sessionId,
      version: '2.1.3', gitBranch: 'main', type, uuid, timestamp: new Date((this.t += 1000)).toISOString(), ...extra };
    this.leaf = uuid;
    return rec;
  }
  user(text: string, extra: object = {}) { return this.base('user', { message: { role: 'user', content: text }, ...extra }); }
  toolResult(id: string) { return this.base('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }); }
  assistant(blocks: any[]) {
    return this.base('assistant', { requestId: 'req_1', message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: 'claude-x',
      content: blocks, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  }
  say(text: string) { return this.assistant([{ type: 'text', text }]); }
  write(recs: unknown[], append = true) { writeLines(this.file, recs, append && fs.existsSync(this.file)); }
}

/** Realistic Codex rollout builder. */
export class CodexFixture {
  id = randomUUID();
  file: string;
  t = Date.parse('2026-09-21T10:00:00Z');
  constructor(codexDir: string, readonly cwd = '/Users/me/proj') {
    this.file = path.join(codexDir, 'sessions', '2026', '09', '21', `rollout-2026-09-21T10-00-00-${this.id}.jsonl`);
  }
  private ts() { return new Date((this.t += 1000)).toISOString(); }
  header() {
    const ts = this.ts();
    return [
      { timestamp: ts, type: 'session_meta', payload: { id: this.id, timestamp: ts, cwd: this.cwd, originator: 'codex_cli_rs', cli_version: '0.50.0', instructions: null, source: 'cli', model_provider: 'openai', git: { branch: 'main' } } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } },
      { timestamp: ts, type: 'turn_context', payload: { cwd: this.cwd, model: 'gpt-5' } },
    ];
  }
  user(text: string) {
    const ts = this.ts();
    return [
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } },
    ];
  }
  say(text: string) {
    const ts = this.ts();
    return [
      { timestamp: ts, type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'x' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
      { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: text } },
    ];
  }
  call(cmd: string) {
    const ts = this.ts();
    return [
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', cmd] }), call_id: 'c1' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'done' } },
    ];
  }
  write(recs: unknown[]) { writeLines(this.file, recs, fs.existsSync(this.file)); }
}

export function makeOld(file: string, secondsAgo = 3600) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
}
