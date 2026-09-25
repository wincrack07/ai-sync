import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseClaude } from '../src/claude/transcript.js';
import { parseCodex, listCodexRollouts } from '../src/codex/rollout.js';
import { listClaudeTranscripts } from '../src/claude/transcript.js';
import { sandbox, ClaudeFixture, CodexFixture, readLines, makeOld, writeLines } from './helpers.js';

const po = { includeTools: 'summary' as const, maxToolChars: 400 };
const texts = (ms: { role: string; text: string }[]) => ms.map((m) => `${m.role}:${m.text}`);

test('claude session is mirrored into a new codex rollout, then sync is idempotent', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('Plan the sync app'), c.say('Here is a plan.'), { type: 'custom-title', customTitle: 'Sync plan', sessionId: c.sessionId }]);
    const s1 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s1.created.codex, 1);
    assert.equal(s1.errors, 0);
    const [link] = sb.ledger.links();
    assert.equal(link.origin, 'claude');
    assert.equal(link.title, 'Sync plan');
    const lines = readLines(link.codex_path);
    assert.equal(lines[0].type, 'session_meta');
    assert.equal(lines[0].payload.id, link.codex_thread_id);
    assert.equal(lines[0].payload.cwd, '/Users/me/proj');
    assert.ok(link.codex_path.includes(link.codex_thread_id));
    const x = parseCodex(link.codex_path, po)!;
    assert.deepEqual(texts(x.messages), ['user:Plan the sync app', 'assistant:Here is a plan.']);

    const before = fs.readFileSync(link.codex_path, 'utf8');
    const s2 = await sb.engine.run({ trigger: 'test', full: true });
    assert.equal(s2.appended.toClaude + s2.appended.toCodex + s2.created.claude + s2.created.codex, 0, 'no echo, no duplicates');
    assert.equal(fs.readFileSync(link.codex_path, 'utf8'), before);
    assert.equal(sb.ledger.links().length, 1);
  } finally { sb.cleanup(); }
});

test('codex thread is mirrored into a valid claude transcript', async () => {
  const sb = sandbox();
  try {
    const cl = new ClaudeFixture(sb.cfg.claudeDir, '/Users/me/other');
    cl.write([cl.user('unrelated'), cl.say('sure')]);
    makeOld(cl.file);
    const x = new CodexFixture(sb.cfg.codexDir);
    x.write([...x.header(), ...x.user('Refactor the parser'), ...x.call('rg parse'), ...x.say('Refactored.')]);
    const s = await sb.engine.run({ trigger: 'test' });
    assert.equal(s.created.claude, 1);
    const link = sb.ledger.links().find((l) => l.origin === 'codex')!;
    assert.ok(link.claude_path.includes('-Users-me-proj'));
    const recs = readLines(link.claude_path);
    assert.equal(recs[0].type, 'custom-title');
    assert.equal(recs[0].customTitle, '[Codex] Refactor the parser');
    const msgs = recs.filter((r) => r.type === 'user' || r.type === 'assistant');
    assert.equal(msgs[0].parentUuid, null);
    for (let i = 1; i < msgs.length; i++) assert.equal(msgs[i].parentUuid, msgs[i - 1].uuid, 'parent chain');
    assert.equal(msgs[0].version, '2.1.3', 'template copied from real transcript');
    assert.equal(msgs[0].sessionId, link.claude_session_id);
    assert.equal(msgs[1].message.model, 'codex-via-ai-sync');
    const p = parseClaude(link.claude_path, po)!;
    assert.ok(p.allMirrored);
    assert.deepEqual(texts(p.messages).map((t) => t.slice(0, 21)), ['user:Refactor the par', 'assistant:▸ shell: {"', 'assistant:Refactored.']);
    const s2 = await sb.engine.run({ trigger: 'test', full: true });
    assert.equal(s2.appended.toClaude + s2.appended.toCodex, 0);
  } finally { sb.cleanup(); }
});

test('turns added on either side flow to the other, without echo', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('q1'), c.say('a1')]);
    await sb.engine.run({ trigger: 'test' });
    const link = sb.ledger.links()[0];

    // User continues the Codex mirror
    const t = '2026-09-22T12:00:00.000Z';
    writeLines(link.codex_path, [
      { timestamp: t, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2 from codex' }] } },
      { timestamp: t, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a2 from codex' }] } },
    ], true);
    const s1 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s1.appended.toClaude, 2);
    let p = parseClaude(c.file, po)!;
    assert.deepEqual(texts(p.messages), ['user:q1', 'assistant:a1', 'user:q2 from codex', 'assistant:a2 from codex']);
    const recs = readLines(c.file).filter((r) => r.type === 'user' || r.type === 'assistant');
    assert.equal(recs[2].parentUuid, recs[1].uuid, 'appended records chain from the old leaf');

    // Then continues in Claude
    c.leaf = recs[recs.length - 1].uuid;
    c.write([c.user('q3 from claude'), c.say('a3 from claude')]);
    const s2 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s2.appended.toCodex, 2);
    assert.equal(s2.appended.toClaude, 0);
    const x = parseCodex(link.codex_path, po)!;
    assert.deepEqual(texts(x.messages), ['user:q1', 'assistant:a1', 'user:q2 from codex', 'assistant:a2 from codex', 'user:q3 from claude', 'assistant:a3 from claude']);

    const s3 = await sb.engine.run({ trigger: 'test', full: true });
    assert.equal(s3.appended.toClaude + s3.appended.toCodex, 0);
    p = parseClaude(c.file, po)!;
    assert.equal(p.messages.length, 6);
  } finally { sb.cleanup(); }
});

test('files modified inside the quiescence window are not written until quiet, unless forced', async () => {
  const sb = sandbox({ quiescenceSec: 60 });
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('busy?'), c.say('yes')]);
    const s1 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s1.created.codex, 0);
    assert.equal(s1.busy, 1);
    makeOld(c.file);
    const s2 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s2.created.codex, 1);

    const link = sb.ledger.links()[0];
    c.leaf = null;
    c.write([c.user('more')]);
    const s3 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s3.appended.toCodex, 1, 'source being fresh is fine; only the target must be quiet');
    // Both tools are live: each target was just modified by someone other than ai-sync.
    writeLines(link.codex_path, [{ timestamp: '2026-09-23T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] } }], true);
    c.write([c.say('live claude turn')]);
    const s4 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s4.busy, 2);
    assert.equal(s4.appended.toClaude + s4.appended.toCodex, 0);
    const s5 = await sb.engine.run({ trigger: 'test', force: true });
    assert.equal(s5.appended.toClaude, 1);
    assert.equal(s5.appended.toCodex, 1);
  } finally { sb.cleanup(); }
});

test('dry run reports actions without touching files or the ledger', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('dry'), c.say('run')]);
    const x = new CodexFixture(sb.cfg.codexDir, '/Users/me/two');
    x.write([...x.header(), ...x.user('other'), ...x.say('thread')]);
    const s = await sb.engine.run({ trigger: 'test', dryRun: true });
    assert.equal(s.created.codex, 1);
    assert.equal(s.created.claude, 1);
    assert.equal(s.actions.length, 2);
    assert.equal(sb.ledger.links().length, 0);
    assert.equal(listCodexRollouts(sb.cfg.codexDir).length, 1);
    assert.equal(listClaudeTranscripts(sb.cfg.claudeDir).length, 1);
    assert.equal(sb.ledger.lastRuns().length, 0);
  } finally { sb.cleanup(); }
});

test('crash recovery confirms written pending rows and drops unwritten ones', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('q'), c.say('a')]);
    await sb.engine.run({ trigger: 'test' });
    const link = sb.ledger.links()[0];
    // Simulate: one message written to codex but crash before markDone; another never written.
    c.write([c.user('written-before-crash'), c.user('never-written')]);
    const p = parseClaude(c.file, po)!;
    const [m1, m2] = p.messages.slice(-2);
    const x = parseCodex(link.codex_path, po)!;
    const { planCodexLines, appendCodex } = await import('../src/codex/rollout.js');
    const planned = planCodexLines({ path: link.codex_path, threadId: link.codex_thread_id, baseCounts: x.baseCounts }, [m1, m2]);
    sb.ledger.addPending(link.id, 'claude', planned.map((q) => ({ nativeId: q.msg.id, mirrorId: q.codexId })), null);
    appendCodex({ path: link.codex_path, threadId: link.codex_thread_id, baseCounts: x.baseCounts }, [planned[0]], true);

    const s = sb.engine.recover();
    assert.equal(s.recovered, 2);
    assert.equal(sb.ledger.pending().length, 0);
    const mapped = sb.ledger.mapped(link.id, 'claude');
    assert.equal(mapped.get(m1.id)?.status, 'done');
    assert.equal(mapped.has(m2.id), false);

    const s2 = await sb.engine.run({ trigger: 'test', full: true });
    assert.equal(s2.appended.toCodex, 1, 'only the unwritten message is sent again');
    const after = parseCodex(link.codex_path, po)!;
    assert.deepEqual(after.messages.map((m) => m.text).slice(-2), ['written-before-crash', 'never-written']);
  } finally { sb.cleanup(); }
});

test('conversations present on both sides are adopted, not duplicated', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('Shared start'), c.say('reply one'), c.assistant([{ type: 'tool_use', id: 't', name: 'Read', input: { file: 'a' } }])]);
    const x = new CodexFixture(sb.cfg.codexDir);
    x.write([...x.header(), ...x.user('Shared start'), ...x.say('reply one'), ...x.user('codex-only follow-up')]);
    const s = await sb.engine.run({ trigger: 'test' });
    assert.equal(s.adopted, 1);
    assert.equal(s.created.claude + s.created.codex, 0);
    const s2 = await sb.engine.run({ trigger: 'test' });
    // The Claude tool call is before the last shared message? No: it is after, so it flows. The codex follow-up flows too.
    assert.equal(s2.appended.toClaude, 1);
    assert.equal(s2.appended.toCodex, 1);
    assert.equal(s2.conflicts, 1);
    const s3 = await sb.engine.run({ trigger: 'test', full: true });
    assert.equal(s3.appended.toClaude + s3.appended.toCodex, 0);
  } finally { sb.cleanup(); }
});

test('a resumed/forked claude file carrying known messages repoints the link', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('original q'), c.say('original a')]);
    await sb.engine.run({ trigger: 'test' });
    makeOld(c.file);
    const link = sb.ledger.links()[0];
    // Fork: new session file with the old records copied (same uuids), then a new turn.
    const old = readLines(c.file);
    const fork = new ClaudeFixture(sb.cfg.claudeDir);
    writeLines(fork.file, old.map((r) => ({ ...r, sessionId: fork.sessionId })));
    fork.leaf = old[old.length - 1].uuid;
    fork.write([fork.user('continued after resume')]);
    const s = await sb.engine.run({ trigger: 'test' });
    assert.equal(s.repointed, 1);
    assert.equal(s.created.codex, 0);
    const s2 = await sb.engine.run({ trigger: 'test' });
    assert.equal(s2.appended.toCodex, 1);
    const l2 = sb.ledger.link(link.id)!;
    assert.equal(l2.claude_session_id, fork.sessionId);
    assert.deepEqual(parseCodex(l2.codex_path, po)!.messages.map((m) => m.text), ['original q', 'original a', 'continued after resume']);
    assert.ok(sb.ledger.isIgnored('claude', c.sessionId));
  } finally { sb.cleanup(); }
});

test('backfill window, project filters and direction switches are honoured', async () => {
  const sb = sandbox({ backfillDays: 7, excludeProjects: ['/Users/me/secret'], codexToClaude: false });
  try {
    const old = new ClaudeFixture(sb.cfg.claudeDir, '/Users/me/old');
    old.write([old.user('ancient'), old.say('x')]);
    makeOld(old.file, 30 * 86400);
    const secret = new ClaudeFixture(sb.cfg.claudeDir, '/Users/me/secret/app');
    secret.write([secret.user('private'), secret.say('x')]);
    const cur = new ClaudeFixture(sb.cfg.claudeDir, '/Users/me/cur');
    cur.write([cur.user('recent'), cur.say('x')]);
    const x = new CodexFixture(sb.cfg.codexDir, '/Users/me/cx');
    x.write([...x.header(), ...x.user('codex thread'), ...x.say('x')]);
    const s = await sb.engine.run({ trigger: 'test' });
    assert.equal(s.created.codex, 1);
    assert.equal(s.created.claude, 0);
    assert.equal(sb.ledger.links()[0].claude_session_id, cur.sessionId);
    const s2 = await sb.engine.run({ trigger: 'test', backfillDays: 0 });
    assert.equal(s2.created.codex, 1, 'explicit backfill picks up the old one');
  } finally { sb.cleanup(); }
});

test('deleted mirror marks the link broken instead of silently re-creating it', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('q'), c.say('a')]);
    await sb.engine.run({ trigger: 'test' });
    const link = sb.ledger.links()[0];
    fs.unlinkSync(link.codex_path);
    c.write([c.user('q2')]);
    await sb.engine.run({ trigger: 'test' });
    assert.equal(sb.ledger.link(link.id)!.status, 'broken');
  } finally { sb.cleanup(); }
});
