import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwarm } from './swarm.ts';
import { scripted } from './mock.ts';
import { summarize, type JournalEvent } from './journal.ts';
import type { SwarmEvent } from './events.ts';

const batches = [
  { id: 'b1', goal: 'make a.txt', tasks: ['create a.txt'] },
  { id: 'b2', goal: 'make b.txt', tasks: ['create b.txt'] },
  { id: 'b3', goal: 'make c.txt', tasks: ['create c.txt'] },
];
const call = (name: string, input: unknown) => ({ tools: [{ name, input }] });
const dispatch = (f: string) => call('dispatch', { id: `t-${f}`, kind: 'boilerplate', goal: `create ${f}`, files: [f], estTokens: 1000 });
// Worker: create its leased file, then report ok.
const beam = () => scripted('beam', (_i, prompt) => {
  if (prompt.includes('created ')) return { text: 'STATUS: ok created the file' };
  const f = prompt.match(/may only write: (\w+\.txt)/)![1];
  return call('write_file', { path: f, content: f });
});

test('big request: plan splits into batches, each verified, context compacted between batches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-batch-'));
  const events: SwarmEvent[] = [];
  const journal: JournalEvent[] = [];
  const prompts: string[] = [];
  const turns = [
    call('plan', { batches, verify: 'true' }),
    dispatch('a.txt'), call('batch_done', { summary: 'a.txt created' }),
    dispatch('b.txt'), call('batch_done', { summary: 'b.txt created' }),
    dispatch('c.txt'), call('batch_done', { summary: 'c.txt created' }),
    { text: 'All three batches done.' },
  ];
  const swarm = createSwarm(dir, {
    emit: (e) => events.push(e),
    journal: (e) => journal.push(e),
    models: { orch: scripted('orch', (i, p) => { prompts.push(p); return turns[i] ?? { text: 'done' }; }), beam: beam() },
  });
  const r = await swarm.generate({ prompt: 'build all three files' });
  assert.equal(r.text, 'All three batches done.');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.equal(await readFile(join(dir, f), 'utf8'), f);

  const seq = events.flatMap((e) => (e.type === 'batch' ? [`${e.id}:${e.status}`] : []));
  assert.deepEqual(seq, ['b1:start', 'b1:done', 'b2:start', 'b2:done', 'b3:start', 'b3:done']);

  // Call 3 = first call of batch 2: batch 1's dispatch (tool call id orch-1-0) is gone, the handoff carries it.
  assert.ok(prompts[1].includes('build all three files'));
  assert.ok(!prompts[3].includes('orch-1-0'), 'batch 1 turns compacted away');
  assert.match(prompts[3], /BATCH HANDOFF[\s\S]*b1 \[done\]: a\.txt created[\s\S]*Current batch 2\/3 \(b2\)/);
  assert.ok(prompts[3].includes('build all three files'), 'original request kept');
  assert.ok(prompts[5].includes('b2 [done]') && !prompts[5].includes('orch-3-0'));

  assert.match(summarize(journal), /batch 3\/3 b3 \[done\]: c\.txt created/); // resume sees plan progress
});

test('verify failing twice halts the plan: no further dispatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-batch-'));
  const events: SwarmEvent[] = [];
  const results: string[] = [];
  const turns = [
    call('plan', { batches, verify: 'exit 3' }),
    dispatch('a.txt'),
    call('batch_done', { summary: 'a' }),
    call('batch_done', { summary: 'a again' }),
    dispatch('b.txt'),
    { text: 'stopped' },
  ];
  const swarm = createSwarm(dir, {
    emit: (e) => events.push(e),
    models: { orch: scripted('orch', (i, p) => { results.push(p); return turns[i] ?? { text: 'done' }; }), beam: beam() },
  });
  await swarm.generate({ prompt: 'build' });
  assert.ok(results[3].includes('VERIFY FAILED for batch b1'));
  assert.ok(results[4].includes('STOP: verify failed twice'));
  assert.ok(results[5].includes('REFUSED: the batch plan is halted'));
  await assert.rejects(access(join(dir, 'b.txt')));
  const last = events.filter((e) => e.type === 'batch').at(-1);
  assert.ok(last?.type === 'batch' && last.id === 'b1' && last.status === 'failed');
});
