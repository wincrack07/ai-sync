import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { type Config, statePaths, home, configPath } from './config.js';
import { writeFileAtomic } from './util.js';

const HOOK_EVENTS = ['Stop', 'SessionEnd'] as const;
const pkgRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Copy the shim into ~/.ai-sync/bin so hook config does not depend on where the repo lives. */
export function installShim(cfg: Config): string {
  const dest = path.join(statePaths(cfg).bin, 'ai-sync-hook.sh');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(pkgRoot(), 'bin', 'ai-sync-hook.sh'), dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function backup(file: string) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.ai-sync-backup-${Date.now()}`);
}

/** Merge Stop/SessionEnd command hooks into ~/.claude/settings.json (idempotent, backed up). */
export function installClaudeHooks(cfg: Config, shim: string): string[] {
  const file = path.join(cfg.claudeDir, 'settings.json');
  let settings: any = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.hooks ??= {};
  const changed: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const groups: any[] = (settings.hooks[ev] ??= []);
    const present = groups.some((g) => (g.hooks ?? []).some((h: any) => h.command === shim));
    if (!present) { groups.push({ hooks: [{ type: 'command', command: shim, timeout: 5 }] }); changed.push(ev); }
  }
  if (changed.length) { backup(file); writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n', 0o644); }
  return changed;
}

export function uninstallClaudeHooks(cfg: Config, shim: string): boolean {
  const file = path.join(cfg.claudeDir, 'settings.json');
  if (!fs.existsSync(file)) return false;
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  for (const ev of HOOK_EVENTS) {
    const groups: any[] = settings.hooks?.[ev];
    if (!groups) continue;
    for (const g of groups) {
      const before = g.hooks?.length ?? 0;
      g.hooks = (g.hooks ?? []).filter((h: any) => h.command !== shim);
      if (g.hooks.length !== before) changed = true;
    }
    settings.hooks[ev] = groups.filter((g) => g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (changed) { backup(file); writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n', 0o644); }
  return changed;
}

/**
 * Codex supports a single top-level `notify = [...]` program. Add ours only if none is set;
 * otherwise report so the user can chain it themselves.
 */
export function installCodexNotify(cfg: Config, shim: string): 'installed' | 'present' | { conflict: string } {
  const file = path.join(cfg.codexDir, 'config.toml');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const top = raw.split(/^\s*\[/m)[0];
  const m = top.match(/^\s*notify\s*=.*$/m);
  if (m) return m[0].includes(shim) ? 'present' : { conflict: m[0].trim() };
  backup(file);
  writeFileAtomic(file, `notify = [${JSON.stringify(shim)}]\n` + raw, 0o644);
  return 'installed';
}

export function writeDefaultConfig(cfg: Config): string | null {
  const file = configPath(cfg.stateDir);
  if (fs.existsSync(file)) return null;
  const { stateDir: _s, ...rest } = cfg;
  writeFileAtomic(file, JSON.stringify(rest, null, 2) + '\n');
  return file;
}

const LABEL = 'tech.xyzsolutions.ai-sync';

/** Install a login agent that keeps the daemon running (launchd on macOS, systemd --user on Linux). */
export function installAgent(cfg: Config, load: boolean): string {
  const node = process.execPath;
  const cli = path.join(pkgRoot(), 'dist', 'src', 'cli.js');
  const logDir = path.dirname(statePaths(cfg).log);
  fs.mkdirSync(logDir, { recursive: true });
  if (process.platform === 'darwin') {
    const file = path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(node)}</string><string>--disable-warning=ExperimentalWarning</string><string>${esc(cli)}</string><string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>AI_SYNC_HOME</key><string>${esc(cfg.stateDir)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'daemon.err.log'))}</string>
</dict></plist>
`;
    writeFileAtomic(file, plist, 0o644);
    if (load) {
      const uid = String(process.getuid?.() ?? '');
      try { execFileSync('launchctl', ['bootout', `gui/${uid}`, file], { stdio: 'ignore' }); } catch { /* not loaded */ }
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file], { stdio: 'inherit' });
    }
    return file;
  }
  const file = path.join(home(), '.config', 'systemd', 'user', 'ai-sync.service');
  writeFileAtomic(file, `[Unit]
Description=ai-sync: Claude <-> Codex chat sync

[Service]
Environment=AI_SYNC_HOME=${cfg.stateDir}
ExecStart=${node} --disable-warning=ExperimentalWarning ${cli} daemon
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`, 0o644);
  if (load) {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'ai-sync.service'], { stdio: 'inherit' });
  }
  return file;
}

export function uninstallAgent(): string | null {
  if (process.platform === 'darwin') {
    const file = path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    if (!fs.existsSync(file)) return null;
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid?.()}`, file], { stdio: 'ignore' }); } catch { /* */ }
    fs.unlinkSync(file);
    return file;
  }
  const file = path.join(home(), '.config', 'systemd', 'user', 'ai-sync.service');
  if (!fs.existsSync(file)) return null;
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'ai-sync.service'], { stdio: 'ignore' }); } catch { /* */ }
  fs.unlinkSync(file);
  return file;
}
