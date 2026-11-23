import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInlineMarkdown } from './tui/tui/markdown.ts';
import { formatPayload, logLine, keyArg, dispatchCard } from './tui/tui/swarm-format.ts';
import { allCommands, filterCommands, parseCommand } from './tui/tui/commands.ts';
import { parseKey } from './tui/tui/terminal-renderer.ts';
import { stripAnsi } from './tui/tui/layout.ts';

const md = (s: string) => renderInlineMarkdown(s);
const plain = (s: string) => stripAnsi(s);

test('markdown: snake_case never italicises; real emphasis still works', () => {
  for (const id of ['cmd_wake', 'load_registry and sync_registry', 'recover_agent_by_title', '__init__ x_y_z', 'a * b * c']) {
    assert.equal(md(id), id, id);
  }
  assert.equal(md('_word_'), '\x1b[3mword\x1b[23m');
  assert.equal(md('**bold** and *it*'), '\x1b[1mbold\x1b[22m and \x1b[3mit\x1b[23m');
});

test('markdown: code spans are literal and keep underscores', () => {
  assert.equal(plain(md('call `load_registry()` and `*x*`')), 'call load_registry() and *x*');
});

test('payload: multi-line strings render as real lines, no \\n or \\" escapes', () => {
  const out = plain(formatPayload({ id: 'fix', goal: 'line "one"\nline two', files: ['a.py', 'b.py'], n: 3 }));
  assert.match(out, /^id: fix$/m);
  assert.match(out, /^goal:$/m);
  assert.match(out, /^ {2}│ line "one"$/m);
  assert.match(out, /^ {2}│ line two$/m);
  assert.match(out, /^files: a\.py, b\.py$/m);
  assert.doesNotMatch(out, /\\n|\\"/);
});

test('payload: terminal control characters from models are escaped', () => {
  assert.doesNotMatch(formatPayload('evil\x1b]2;pwned\x07'), /\x1b\]2;pwned/);
});

test('logLine: engine log JSON (even truncated) becomes "tool  arg"', () => {
  assert.equal(plain(logLine('edit_file {"path":"app.py","old_string":"    pass","new_stri')), 'edit_file  app.py');
  assert.equal(plain(logLine('run_command {"command":"echo \\"hi\\""}')), 'run_command  echo "hi"');
  assert.equal(keyArg('list_files', { dir: '.' }), '.');
});

test('dispatch card: worker, badge, collapsed goal, failure detection', () => {
  const card = dispatchCard({
    input: { id: 'fix', kind: 'bugfix', goal: '1\n2\n3\n4\n5' }, progress: { worker: 'beam', summary: 'NO FINAL REPORT: stopped' },
    finished: true, expanded: false, focused: false,
  });
  assert.match(plain(card.header), /◆ dispatch \[bugfix\] fix → Beam · beam-free {2}✗ failed/);
  assert.ok(card.body.some((l) => /2 more lines/.test(plain(l))));
});

test('commands: prefix then fuzzy filtering, parsing with args', () => {
  const cmds = allCommands();
  assert.equal(filterCommands(cmds, 're')[0].name, 'resume');
  assert.ok(filterCommands(cmds, 'wks').some((c) => c.name === 'workers'));
  const p = parseCommand(cmds, '/mode ask');
  assert.equal(p?.[0].name, 'mode');
  assert.equal(p?.[1], 'ask');
  assert.equal(parseCommand(cmds, '/nope'), undefined);
});

test('keys: shift-tab, ctrl-arrows, palette keys, escape sequences never typed as text', () => {
  const k = (s: string) => parseKey(Buffer.from(s)).type;
  assert.equal(k('\x1b[Z'), 'shift-tab');
  assert.equal(k('\x1b[1;5A'), 'ctrl-up');
  assert.equal(k('\t'), 'tab');
  assert.equal(k('\x10'), 'ctrl-p');
  assert.equal(k('\x1b[1;2C'), 'ignore');
});

import { renderMarkdown } from './tui/tui/markdown.ts';
test('markdown: fenced code is literal with a gutter, fences removed', () => {
  const out = stripAnsi(renderMarkdown('Before\n```python\ndef cmd_wake(): **x**\n```\nAfter _it_'));
  assert.equal(out, 'Before\npython\n│ def cmd_wake(): **x**\nAfter it');
});

import { toolSummary, exploreSummary, cleanSummary } from './tui/tui/swarm-format.ts';
test('inline: headings are bold without glyphs; tool summaries and explore groups read like Claude Code', () => {
  assert.equal(stripAnsi(renderMarkdown('## Done')), 'Done');
  assert.equal(toolSummary('read_file', 'a\nb\nc'), 'Read 3 lines');
  assert.equal(toolSummary('list_files', ['a', 'b/']), '2 entries');
  assert.equal(toolSummary('run_command', 'exit=0\nhello\n'), 'exit 0  hello');
  assert.match(toolSummary('edit_file', 'DENIED: x is not in your lease'), /^DENIED/);
  assert.deepEqual(exploreSummary([{ name: 'read_file', input: { path: 'a.py' } }, { name: 'list_files', input: { dir: '.' } }, { name: 'read_file', input: { path: 'b.py' } }]),
    { title: 'Read 2 files, listed 1 directory', detail: 'a.py, ., b.py' });
  assert.deepEqual(cleanSummary('[beam: scoped task] attempt 1\nSTATUS: ok\nEdited app.py.'), ['Edited app.py.']);
});
