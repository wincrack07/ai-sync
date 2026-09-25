import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Daemon, ctl } from '../src/daemon.js';
import { statePaths } from '../src/config.js';
import { installClaudeHooks, installCodexNotify, uninstallClaudeHooks } from '../src/install.js';
import { sandbox, ClaudeFixture } from './helpers.js';

const waitFor = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout');
};

test('daemon: startup sync, socket control, hook spool and fs triggers', async () => {
  const sb = sandbox({ watch: true, debounceMs: 50, intervalSec: 3600 });
  sb.ledger.close();
  const d = new Daemon(sb.cfg);
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('daemon q'), c.say('daemon a')]);
    await d.start();
    await waitFor(() => d.state.lastRun?.stats.created.codex === 1);
    const sp = statePaths(sb.cfg);

    const st = await ctl(sp.sock, { cmd: 'status' });
    assert.equal(st.ok, true);
    assert.equal(st.links, 1);

    assert.deepEqual(await ctl(sp.sock, { cmd: 'pause' }), { ok: true, paused: true });
    assert.equal((await ctl(sp.sock, { cmd: 'resume' })).paused, false);

    // Hook shim drops a spool file -> daemon syncs.
    c.write([c.user('after hook')]);
    const shim = path.resolve('bin/ai-sync-hook.sh');
    execFileSync(shim, [], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: c.sessionId }), env: { ...process.env, AI_SYNC_HOME: sb.cfg.stateDir } });
    await waitFor(() => (d.state.triggersSeen.hook ?? 0) > 0);
    await waitFor(() => d.state.lastRun?.stats.appended.toCodex === 1);
    assert.equal(fs.readdirSync(sp.spool).length, 0, 'spool drained');

    const r = await ctl(sp.sock, { cmd: 'sync-now', full: true });
    assert.equal(r.ok, true);
    assert.equal(r.stats.appended.toCodex, 0);
  } finally {
    await d.stop();
    assert.equal(fs.existsSync(statePaths(sb.cfg).lock), false, 'lock released');
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});

test('second daemon refuses to start while the first holds the lock', async () => {
  const sb = sandbox({ watch: false, intervalSec: 3600 });
  sb.ledger.close();
  const d1 = new Daemon(sb.cfg);
  await d1.start();
  try {
    await assert.rejects(new Daemon(sb.cfg).start(), /another ai-sync daemon/);
  } finally { await d1.stop(); fs.rmSync(sb.root, { recursive: true, force: true }); }
});

test('hook installation merges into existing settings and is idempotent', () => {
  const sb = sandbox();
  try {
    const settings = path.join(sb.cfg.claudeDir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    const shim = '/x/ai-sync-hook.sh';
    assert.deepEqual(installClaudeHooks(sb.cfg, shim), ['Stop', 'SessionEnd']);
    assert.deepEqual(installClaudeHooks(sb.cfg, shim), []);
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(s.model, 'opus');
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
    assert.ok(uninstallClaudeHooks(sb.cfg, shim));
    const s2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(s2.hooks.Stop.length, 1);
    assert.equal(s2.hooks.SessionEnd, undefined);

    const toml = path.join(sb.cfg.codexDir, 'config.toml');
    fs.writeFileSync(toml, 'model = "gpt-5"\n\n[profiles.x]\nnotify = ["nested-is-not-top-level"]\n');
    assert.equal(installCodexNotify(sb.cfg, shim), 'installed');
    assert.equal(installCodexNotify(sb.cfg, shim), 'present');
    assert.ok(fs.readFileSync(toml, 'utf8').startsWith(`notify = ["${shim}"]\nmodel`));
    fs.writeFileSync(toml, 'notify = ["other"]\n');
    assert.deepEqual(installCodexNotify(sb.cfg, shim), { conflict: 'notify = ["other"]' });
  } finally { sb.cleanup(); }
});
