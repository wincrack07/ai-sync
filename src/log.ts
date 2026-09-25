import * as fs from 'node:fs';
import * as path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.AI_SYNC_LOG_LEVEL as Level) || 'info';
let logFile: string | null = null;
let quiet = false;

export function configureLog(opts: { file?: string | null; level?: Level; quiet?: boolean }) {
  if (opts.file !== undefined) {
    logFile = opts.file;
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  if (opts.level) minLevel = opts.level;
  if (opts.quiet !== undefined) quiet = opts.quiet;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < order[minLevel]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ } }
  if (!quiet) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, x?: Record<string, unknown>) => emit('debug', m, x),
  info: (m: string, x?: Record<string, unknown>) => emit('info', m, x),
  warn: (m: string, x?: Record<string, unknown>) => emit('warn', m, x),
  error: (m: string, x?: Record<string, unknown>) => emit('error', m, x),
};
