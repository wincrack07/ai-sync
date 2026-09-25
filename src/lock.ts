import * as fs from 'node:fs';
import * as path from 'node:path';

/** Single-instance lock via an O_EXCL pidfile; stale locks (dead pid) are reclaimed. */
export function acquireLock(file: string): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (pid && isAlive(pid)) throw new Error(`another ai-sync daemon is running (pid ${pid})`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('could not acquire lock');
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; }
}
