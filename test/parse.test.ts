import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude, projectSlug } from '../src/claude/transcript.js';
import { parseCodex } from '../src/codex/rollout.js';
import { sandbox, ClaudeFixture, CodexFixture } from './helpers.js';

const po = { includeTools: 'summary' as const, maxToolChars: 100 };

test('claude parser keeps real turns and drops noise', () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([
      c.user('<command-name>/model</command-name>'),
      c.user('hidden', { isMeta: true }),
      c.user('Fix the login bug\n<system-reminder>ignore me</system-reminder>'),
      c.assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking now.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      c.toolResult('t1'),
      c.user('side', { isSidechain: true }),
      c.say('Fixed it.'),
      { type: 'custom-title', customTitle: 'Login bug', sessionId: c.sessionId },
      { type: 'summary', summary: 'older summary', leafUuid: c.leaf },
    ]);
    const p = parseClaude(c.file, po)!;
    assert.equal(p.id, c.sessionId);
    assert.equal(p.cwd, '/Users/me/proj');
    assert.equal(p.title, 'Login bug');
    assert.deepEqual(p.messages.map((m) => [m.role, m.kind, m.text]), [
      ['user', 'text', 'Fix the login bug'],
      ['assistant', 'text', 'Looking now.'],
      ['assistant', 'tool', '▸ Bash: {"command":"ls"}'],
      ['assistant', 'text', 'Fixed it.'],
    ]);
    assert.equal(p.template.version, '2.1.3');
    assert.ok(p.leafUuid);
    assert.equal(parseClaude(c.file, { ...po, includeTools: 'none' })!.messages.length, 3);
  } finally { sb.cleanup(); }
});

test('claude parser tolerates a torn last line', async () => {
  const sb = sandbox();
  try {
    const c = new ClaudeFixture(sb.cfg.claudeDir);
    c.write([c.user('hi'), c.say('hello')]);
    (await import('node:fs')).appendFileSync(c.file, '{"type":"user","mess');
    assert.equal(parseClaude(c.file, po)!.messages.length, 2);
  } finally { sb.cleanup(); }
});

test('project slug matches Claude Code encoding', () => {
  assert.equal(projectSlug('/Users/juliosaldana/XYZ/AI-Sync'), '-Users-juliosaldana-XYZ-AI-Sync');
  assert.equal(projectSlug('/a/b.c_d'), '-a-b-c-d');
});

test('codex parser reads response items, skips injected context and event_msg duplicates', () => {
  const sb = sandbox();
  try {
    const x = new CodexFixture(sb.cfg.codexDir);
    x.write([...x.header(), ...x.user('Add tests'), ...x.call('npm test'), ...x.say('Done.'), ...x.user('ok'), ...x.user('ok')]);
    const p = parseCodex(x.file, po)!;
    assert.equal(p.id, x.id);
    assert.equal(p.cwd, '/Users/me/proj');
    assert.deepEqual(p.messages.map((m) => [m.role, m.kind, m.text.slice(0, 12)]), [
      ['user', 'text', 'Add tests'], ['assistant', 'tool', '▸ shell: {"c'], ['assistant', 'text', 'Done.'], ['user', 'text', 'ok'], ['user', 'text', 'ok'],
    ]);
    assert.equal(new Set(p.messages.map((m) => m.id)).size, p.messages.length, 'ids unique');
    assert.deepEqual(parseCodex(x.file, po)!.messages.map((m) => m.id), p.messages.map((m) => m.id), 'ids stable');
    assert.equal(p.title, 'Add tests');
  } finally { sb.cleanup(); }
});

test('codex parser handles legacy rollouts without type wrappers', async () => {
  const sb = sandbox();
  try {
    const x = new CodexFixture(sb.cfg.codexDir);
    const { writeLines } = await import('./helpers.js');
    writeLines(x.file, [
      { id: x.id, timestamp: '2025-01-01T00:00:00Z', instructions: null },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy q' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'legacy a' }] },
    ]);
    const p = parseCodex(x.file, po)!;
    assert.equal(p.id, x.id);
    assert.deepEqual(p.messages.map((m) => m.text), ['legacy q', 'legacy a']);
  } finally { sb.cleanup(); }
});
