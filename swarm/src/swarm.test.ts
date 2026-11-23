import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route, type Task } from './route.ts';
import { createSwarm } from './swarm.ts';
import { scripted } from './mock.ts';
import type { SwarmEvent, Gate } from './events.ts';

const base: Task = { id: 't1', kind: 'bugfix', goal: 'x', files: ['a.ts'], estTokens: 20_000, attempt: 1 };
test('force overrides every routing rule', () => {
  assert.equal(route({ ...base, kind: 'architecture', force: 'beam' }).worker, 'beam');
  assert.match(route({ ...base, force: 'beam' }).reason, /manual override/);
});

const dispatchTurn = (id: string, files: string[], goal = `goal ${id}`) =>
  ({ tools: [{ name: 'dispatch', input: { id, kind: 'bugfix', goal, files, estTokens: 1000 } }] });

async function ws() {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  return dir;
}

test('mock run: dispatch -> beam edits file, events + journal emitted', async () => {
  const dir = await ws();
  const events: SwarmEvent[] = [];
  const journal: string[] = [];
  const swarm = createSwarm(dir, {
    emit: (e) => events.push(e),
    journal: (e) => journal.push(e.type),
    models: {
      orch: scripted('orch', [dispatchTurn('fix', ['a.txt']), { text: 'All done.' }]),
      beam: scripted('beam', [
        { tools: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'two', new_string: 'TWO' } }] },
        { text: 'STATUS: ok changed a.txt' },
      ]),
    },
  });
  const r = await swarm.generate({ prompt: 'fix a.txt' });
  assert.equal(r.text, 'All done.');
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  const types = events.map((e) => e.type);
  for (const t of ['dispatch', 'tool.start', 'tool.end', 'file.edit', 'task.result', 'step.end', 'text.delta']) assert.ok(types.includes(t as never), t);
  const edit = events.find((e) => e.type === 'file.edit');
  assert.ok(edit && edit.type === 'file.edit' && edit.before === 'one\ntwo\nthree\n' && edit.after === 'one\nTWO\nthree\n');
  const res = events.find((e) => e.type === 'task.result');
  assert.ok(res && res.type === 'task.result' && res.status === 'ok' && res.worker === 'beam');
  assert.deepEqual(journal.filter((t) => ['dispatch', 'result'].includes(t)), ['dispatch', 'result']); // legacy journal unchanged
});

test('gate deny blocks run_command (sandbox never runs)', async () => {
  const dir = await ws();
  const asked: string[] = [];
  const gate: Gate = {
    beforeTool: async (_a, tool, input) => { asked.push(`${tool}:${JSON.stringify(input)}`); return { approve: false }; },
    checkpoint: async () => {},
  };
  const outputs: string[] = [];
  const swarm = createSwarm(dir, {
    gate, emit: (e) => { if (e.type === 'tool.end') outputs.push(e.outputTail); },
    models: {
      orch: scripted('orch', [dispatchTurn('t', []), { text: 'ok' }]),
      beam: scripted('beam', [{ tools: [{ name: 'run_command', input: { command: 'rm -rf .' } }] }, { text: 'STATUS: failed denied' }]),
    },
  });
  await swarm.generate({ prompt: 'x' });
  assert.deepEqual(asked, ['run_command:{"command":"rm -rf ."}']);
  assert.ok(outputs.some((o) => o.startsWith('DENIED')));
});

test('destructive edit asks the gate; small edit does not', async () => {
  const dir = await ws();
  await writeFile(join(dir, 'big.txt'), 'keep\n' + 'x'.repeat(1000));
  const asked: string[] = [];
  const gate: Gate = { beforeTool: async (_a, t) => { asked.push(t); return { approve: true }; }, checkpoint: async () => {} };
  const swarm = createSwarm(dir, {
    gate,
    models: {
      orch: scripted('orch', [dispatchTurn('t', ['big.txt', 'a.txt']), { text: 'ok' }]),
      beam: scripted('beam', [
        { tools: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'one', new_string: '1' } }] },
        { tools: [{ name: 'edit_file', input: { path: 'big.txt', old_string: 'x'.repeat(1000), new_string: '' } }] },
        { text: 'STATUS: ok' },
      ]),
    },
  });
  await swarm.generate({ prompt: 'x' });
  assert.deepEqual(asked, ['edit_file']);
  assert.equal(await readFile(join(dir, 'big.txt'), 'utf8'), 'keep\n');
});

test('cancel aborts a running worker; redispatch with force reruns it on deepseek', async () => {
  const dir = await ws();
  const events: SwarmEvent[] = [];
  let swarm!: ReturnType<typeof createSwarm>;
  let cancelled = false;
  const gate: Gate = {
    beforeTool: async () => ({ approve: true }),
    // pause point: cancel the worker the first time it reaches a step boundary after step 0
    checkpoint: async (agent) => {
      if (!cancelled && agent === 'task:slow' && events.some((e) => e.type === 'tool.end')) cancelled = swarm.controls.cancel('slow');
    },
  };
  swarm = createSwarm(dir, {
    gate, emit: (e) => events.push(e),
    models: {
      orch: scripted('orch', [dispatchTurn('slow', []), { text: 'reported' }]),
      beam: scripted('beam', [{ tools: [{ name: 'list_files', input: {} }] }, { text: 'STATUS: ok never' }]),
      deepseek: scripted('deepseek', [{ text: 'STATUS: ok rerun on deepseek' }]),
    },
  });
  await swarm.generate({ prompt: 'x' });
  const r1 = events.find((e) => e.type === 'task.result');
  assert.ok(r1 && r1.type === 'task.result' && r1.status === 'cancelled', JSON.stringify(r1));
  const out = await swarm.controls.redispatch('slow', 'deepseek');
  assert.match(out, /^\[deepseek: manual override/);
  assert.ok(events.some((e) => e.type === 'dispatch' && e.worker === 'deepseek' && e.forcedBy === 'user'));
});

test('lease clash emits lease.conflict with the holder', async () => {
  const dir = await ws();
  const events: SwarmEvent[] = [];
  const swarm = createSwarm(dir, {
    emit: (e) => events.push(e),
    models: {
      orch: scripted('orch', [{ tools: [dispatchTurn('a', ['a.txt']).tools[0], dispatchTurn('b', ['a.txt']).tools[0]] }, { text: 'ok' }]),
      beam: scripted('beam', [{ text: 'STATUS: ok', delayMs: 20 }, { text: 'STATUS: ok' }]),
    },
  });
  await swarm.generate({ prompt: 'x' });
  const c = events.find((e) => e.type === 'lease.conflict');
  assert.ok(c && c.type === 'lease.conflict' && c.heldBy.length === 1, JSON.stringify(c));
});
