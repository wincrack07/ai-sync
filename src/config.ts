import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Config {
  claudeDir: string;          // ~/.claude
  codexDir: string;           // ~/.codex
  stateDir: string;           // ~/.ai-sync
  intervalSec: number;        // periodic reconcile interval
  quiescenceSec: number;      // don't write into a file modified more recently than this
  debounceMs: number;         // coalesce filesystem/hook triggers
  backfillDays: number;       // only auto-mirror conversations touched in the last N days (0 = all)
  includeTools: 'summary' | 'none';
  maxToolChars: number;
  claudeToCodex: boolean;
  codexToClaude: boolean;
  /** Only sync conversations whose cwd starts with one of these prefixes (empty = all). */
  projects: string[];
  /** Never sync conversations whose cwd starts with one of these prefixes. */
  excludeProjects: string[];
  /** Prefix for the title of Claude sessions created from Codex threads. */
  titlePrefix: { fromCodex: string };
  /** Model label on assistant records ai-sync writes into Claude transcripts. */
  claudeMirrorModel: string;
  codex: {
    /** Also write event_msg lines so Codex's resume UI can replay history. */
    writeEventMsgs: boolean;
    /** Optional shell command run after a Codex mirror is created. {path} and {id} are substituted. */
    postCreateCommand: string | null;
  };
  watch: boolean;
}

export function home(): string {
  return process.env.AI_SYNC_USER_HOME || os.homedir();
}

export function defaultConfig(): Config {
  const h = home();
  return {
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(h, '.claude'),
    codexDir: process.env.CODEX_HOME || path.join(h, '.codex'),
    stateDir: process.env.AI_SYNC_HOME || path.join(h, '.ai-sync'),
    intervalSec: 60,
    quiescenceSec: 20,
    debounceMs: 1500,
    backfillDays: 7,
    includeTools: 'summary',
    maxToolChars: 400,
    claudeToCodex: true,
    codexToClaude: true,
    projects: [],
    excludeProjects: [],
    titlePrefix: { fromCodex: '[Codex] ' },
    claudeMirrorModel: 'codex-via-ai-sync',
    codex: { writeEventMsgs: true, postCreateCommand: null },
    watch: true,
  };
}

export const configPath = (stateDir: string) => path.join(stateDir, 'config.json');

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base = defaultConfig();
  const stateDir = overrides.stateDir ?? base.stateDir;
  let file: Partial<Config> = {};
  try { file = JSON.parse(fs.readFileSync(configPath(stateDir), 'utf8')); } catch { /* defaults */ }
  const cfg: Config = {
    ...base, ...file, ...overrides,
    titlePrefix: { ...base.titlePrefix, ...(file.titlePrefix ?? {}), ...(overrides.titlePrefix ?? {}) },
    codex: { ...base.codex, ...(file.codex ?? {}), ...(overrides.codex ?? {}) },
  };
  cfg.stateDir = stateDir;
  for (const k of ['claudeDir', 'codexDir', 'stateDir'] as const) cfg[k] = expandHome(cfg[k]);
  cfg.projects = cfg.projects.map(expandHome);
  cfg.excludeProjects = cfg.excludeProjects.map(expandHome);
  return cfg;
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(home(), p.slice(1)) : p;
}

export function cwdAllowed(cfg: Config, cwd: string): boolean {
  if (cfg.excludeProjects.some((p) => cwd.startsWith(p))) return false;
  if (!cfg.projects.length) return true;
  return cfg.projects.some((p) => cwd.startsWith(p));
}

export const statePaths = (cfg: Config) => ({
  db: path.join(cfg.stateDir, 'ledger.sqlite'),
  lock: path.join(cfg.stateDir, 'daemon.lock'),
  sock: path.join(cfg.stateDir, 'ai-sync.sock'),
  spool: path.join(cfg.stateDir, 'spool'),
  log: path.join(cfg.stateDir, 'logs', 'ai-sync.log'),
  bin: path.join(cfg.stateDir, 'bin'),
});
