import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, Leases, type Task } from './route.ts';
import { stripReasoning, viewImageTool } from './swarm.ts';

test('stripReasoning drops assistant reasoning only', () => {
  const out = stripReasoning([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }] },
  ]);
  assert.deepEqual(out[1], { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  assert.equal(out[0].content, 'hi');
});

const base: Task = { id: 't1', kind: 'bugfix', goal: 'x', files: ['a.ts'], estTokens: 20_000, attempt: 1 };

test('scoped bugfix goes to flint', () => assert.equal(route(base).worker, 'flint'));
test('big context goes to beam even if flint preferred', () =>
  assert.equal(route({ ...base, estTokens: 400_000, prefer: 'flint' }).worker, 'beam'));
test('long-horizon kinds go to beam', () => assert.equal(route({ ...base, kind: 'terminal' }).worker, 'beam'));
test('wide change goes to beam', () => assert.equal(route({ ...base, files: ['1', '2', '3', '4', '5', '6'] }).worker, 'beam'));
test('second attempt escalates', () => assert.equal(route({ ...base, attempt: 2 }).worker, 'beam'));
test('final attempt on a scoped task goes to qwen', () => assert.equal(route({ ...base, attempt: 3 }).worker, 'qwen'));
test('final attempt on a big task goes to deepseek', () => {
  assert.equal(route({ ...base, attempt: 3, estTokens: 400_000 }).worker, 'deepseek');
  assert.equal(route({ ...base, attempt: 3, kind: 'refactor' }).worker, 'deepseek');
});
test('visual tasks go to vision models by size, swapping on the final attempt', () => {
  assert.equal(route({ ...base, visual: true }).worker, 'qwen');
  assert.equal(route({ ...base, visual: true, attempt: 2 }).worker, 'qwen');
  assert.equal(route({ ...base, visual: true, attempt: 3 }).worker, 'deepseek');
  assert.equal(route({ ...base, visual: true, kind: 'refactor' }).worker, 'deepseek');
  assert.equal(route({ ...base, visual: true, kind: 'refactor', attempt: 3 }).worker, 'qwen');
});
test('paid models only via the final attempt or force', () => {
  for (const a of [1, 2]) assert.ok(['beam', 'flint'].includes(route({ ...base, attempt: a, kind: 'explore' }).worker));
  assert.equal(route({ ...base, force: 'deepseek' }).worker, 'deepseek');
});
test('attempt budget enforced', () => assert.throws(() => route({ ...base, attempt: 4 })));

test('leases reject overlap and release cleanly', () => {
  const l = new Leases();
  assert.deepEqual(l.acquire('t1', ['a.ts', 'b.ts']), []);
  assert.deepEqual(l.acquire('t2', ['b.ts', 'c.ts']), ['b.ts']);
  assert.equal(l.holds('t2', 'c.ts'), false); // all-or-nothing
  l.release('t1');
  assert.deepEqual(l.acquire('t2', ['b.ts', 'c.ts']), []);
});

import { summarize } from './journal.ts';
import { runSandboxed, bwrapArgs } from './sandbox.ts';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('summarize restores asks, latest result per task, and unfinished state', () => {
  const s = summarize([
    { type: 'user', text: 'do TASK.md' },
    { type: 'result', id: 't1', status: 'failed', summary: 'first' },
    { type: 'result', id: 't1', status: 'ok', summary: 'second' },
    { type: 'step', text: 'dispatched t1', tools: ['dispatch'] },
  ]);
  assert.match(s, /do TASK\.md/);
  assert.match(s, /t1 \[ok\]: second/);
  assert.doesNotMatch(s, /first/);
  assert.match(s, /stopped without finishing/);
});

test('bwrap mounts tmpfs before the workspace bind', () => {
  const a = bwrapArgs('/home/u/ws', 'true');
  assert.ok(a.indexOf('/home') < a.lastIndexOf('/home/u/ws'));
});

test('sandbox: workspace writable, no network, home hidden', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swarm-sbx-'));
  writeFileSync(join(ws, 'in.txt'), 'hi');
  const out = await runSandboxed(ws, 'cat in.txt; echo ok > out.txt; ls /home | wc -l; curl -sS -m 3 https://example.com >/dev/null 2>&1 || echo nonet');
  assert.match(out, /^exit=0/);
  assert.match(out, /hi/);
  assert.match(out, /nonet/);
  assert.equal(readFileSync(join(ws, 'out.txt'), 'utf8'), 'ok\n');
  assert.match(await runSandboxed(ws, 'exit 3'), /^exit=3/);
});

import { makeFsTools } from './swarm.ts';

test('file tools: create-only write, unique edit, lease + path guards, read elision', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'swarm-fs-'));
  const leases = new Leases();
  leases.acquire('t', ['a.py', 'new.py']);
  const t = makeFsTools(ws, leases, 't');
  const call = (name: keyof typeof t, input: object) => (t[name] as any).execute(input, {} as any);
  writeFileSync(join(ws, 'a.py'), 'x = 1\ny = 1\n');
  assert.match(await call('write_file', { path: 'a.py', content: 'truncated' }), /DENIED: a\.py exists/);
  assert.equal(readFileSync(join(ws, 'a.py'), 'utf8'), 'x = 1\ny = 1\n');
  assert.match(await call('write_file', { path: 'new.py', content: 'n' }), /created new\.py/);
  assert.match(await call('edit_file', { path: 'a.py', old_string: '= 1', new_string: '= 2' }), /matches 2 times/);
  assert.match(await call('edit_file', { path: 'a.py', old_string: 'y = 1', new_string: 'y = $&2' }), /edited/);
  assert.equal(readFileSync(join(ws, 'a.py'), 'utf8'), 'x = 1\ny = $&2\n'); // no regex replacement patterns
  assert.match(await call('edit_file', { path: 'other.py', old_string: 'a', new_string: 'b' }), /not in your lease/);
  await assert.rejects(call('read_file', { path: '../../etc/passwd' }), /escapes workspace/);
  assert.match(await call('read_file', { path: 'a.py' }), /y = \$&2/);
  assert.match(await call('read_file', { path: 'a.py' }), /unchanged since/);
});

import { linkedDepBinds } from './sandbox.ts';
import { mkdirSync, symlinkSync } from 'node:fs';

test('sandbox: file: deps are mounted read-only with .env masked', async () => {
  const base = mkdtempSync(join(tmpdir(), 'swarm-link-'));
  const ws = join(base, 'ws'); const dep = join(base, 'dep');
  mkdirSync(join(ws, 'node_modules'), { recursive: true }); mkdirSync(dep);
  writeFileSync(join(dep, 'types.ts'), 'export type T = 1;'); writeFileSync(join(dep, '.env'), 'SECRET=abc');
  symlinkSync(dep, join(ws, 'node_modules', 'dep'));
  assert.ok(linkedDepBinds(ws).includes(dep));
  const out = await runSandboxed(ws, 'cat node_modules/dep/types.ts; cat node_modules/dep/.env; echo; touch node_modules/dep/x 2>&1 | head -1');
  assert.match(out, /export type T = 1;/);
  assert.doesNotMatch(out, /SECRET=abc/);
  assert.match(out, /Read-only file system/);
});

test('view_image returns the image as a file part, rejects non-images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewimg-'));
  writeFileSync(join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'a.txt'), 'x');
  const t = viewImageTool(dir);
  const ok = await t.execute!({ path: 'a.png' }, { toolCallId: '1', messages: [] } as never);
  const out = await t.toModelOutput!({ toolCallId: '1', input: { path: 'a.png' }, output: ok } as never) as { type: string; value: { type: string; mediaType?: string }[] };
  assert.equal(out.type, 'content');
  assert.equal(out.value[1].type, 'file');
  assert.equal(out.value[1].mediaType, 'image/png');
  const bad = await t.execute!({ path: 'a.txt' }, { toolCallId: '2', messages: [] } as never);
  assert.ok('error' in (bad as object));
});
