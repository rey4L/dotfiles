// Engine hooks for the 2026-11-22 optimization round: compaction, stateful resume, transient retry, context files,
// write nudge, mailbox (+ inbox file), modes, needs-you count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwarm } from './swarm.ts';
import { scripted, type MockTurn } from './mock.ts';
import { resumeState, pendingCount, type JournalEvent } from './journal.ts';
import type { SwarmEvent } from './events.ts';

const call = (name: string, input: unknown): MockTurn => ({ tools: [{ name, input }] });
const tmp = () => mkdtemp(join(tmpdir(), 'swarm-brain-'));
const orch = (turns: MockTurn[], prompts: string[] = []) => scripted('orch', (i, p) => { prompts.push(p); return turns[i] ?? { text: 'done' }; });
const batches = [{ id: 'b1', goal: 'a', tasks: ['a'] }, { id: 'b2', goal: 'b', tasks: ['b'] }, { id: 'b3', goal: 'c', tasks: ['c'] }];

test('compaction happens once: steps after a batch handoff stay visible to the orchestrator', async () => {
  const prompts: string[] = [];
  const turns = [call('plan', { batches }), call('batch_done', { summary: 'a' }), call('status', {}), call('list_files', {}), { text: 'end' }];
  const swarm = createSwarm(await tmp(), { models: { orch: orch(turns, prompts) } });
  await swarm.generate({ prompt: 'REQ' });
  assert.ok(prompts[2].includes('BATCH HANDOFF') && !prompts[2].includes('orch-0-0'), 'batch 1 compacted');
  assert.ok(prompts[3].includes('orch-2-0'), 'status call of batch 2 still in context');
  assert.ok(prompts[4].includes('orch-2-0') && prompts[4].includes('orch-3-0'));
  assert.ok(prompts[4].includes('REQ'), 'original request kept');
});

test('resume restores plan position and attempt counts', async () => {
  const dir = await tmp();
  const journal: JournalEvent[] = [];
  const failFlint = scripted('flint', () => ({ text: 'STATUS: failed could not' }));
  const run1 = createSwarm(dir, {
    journal: (e) => journal.push(e),
    models: { orch: orch([call('plan', { batches, verify: 'true' }), call('batch_done', { summary: 'a done' }),
      call('dispatch', { id: 'tb', kind: 'boilerplate', goal: 'make b', files: ['b.txt'], estTokens: 100 }), { text: 'stopped' }]), flint: failFlint },
  });
  await run1.generate({ prompt: 'go' });
  const st = resumeState(journal);
  assert.equal(st.batchIdx, 1);
  assert.equal(st.attempts.get('tb'), 1);

  const events: SwarmEvent[] = [];
  const prompts: string[] = [];
  const run2 = createSwarm(dir, {
    resume: st, emit: (e) => events.push(e),
    models: { orch: orch([call('dispatch', { id: 'tb', kind: 'boilerplate', goal: 'make b again', files: ['b.txt'], estTokens: 100 }),
      call('batch_done', { summary: 'b done' }), { text: 'end' }], prompts), beam: scripted('beam', () => ({ text: 'STATUS: ok' })) },
  });
  await run2.generate({ prompt: 'continue' });
  const d = events.find((e) => e.type === 'dispatch');
  assert.ok(d?.type === 'dispatch' && d.attempt === 2 && d.worker === 'beam', 'second attempt escalates across the resume');
  assert.match(prompts[2], /b2 \[done\]: b done[\s\S]*Current batch 3\/3 \(b3\)/, 'batch_done works after resume');
});

test('a transient provider error retries the same worker once without counting an attempt', async () => {
  const dir = await tmp();
  let n = 0;
  const flint = scripted('flint', () => (n++ === 0 ? { fail: 'inference service temporarily unavailable' } : { text: 'STATUS: ok fine' }));
  const events: SwarmEvent[] = [];
  const swarm = createSwarm(dir, {
    retryDelayMs: 0, emit: (e) => events.push(e),
    models: { orch: orch([call('dispatch', { id: 't', kind: 'boilerplate', goal: 'x', files: ['x.txt'], estTokens: 10 }), { text: 'end' }]), flint },
  });
  await swarm.generate({ prompt: 'go' });
  const r = events.find((e) => e.type === 'task.result');
  assert.ok(r?.type === 'task.result' && r.status === 'ok' && r.worker === 'flint');
  assert.equal(events.filter((e) => e.type === 'dispatch').length, 1);
  assert.ok(events.some((e) => e.type === 'ratelimit' && /transient/.test(e.message)));
});

test('context files are inlined into the worker prompt and a re-read is elided', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'SPEC.md'), 'THE-SPEC-BODY');
  const prompts: string[] = [];
  const flint = scripted('flint', (i, p) => { prompts.push(p); return i % 2 === 0 ? call('read_file', { path: 'SPEC.md' }) : { text: 'STATUS: ok' }; });
  const d = (id: string) => call('dispatch', { id, kind: 'boilerplate', goal: `do ${id}`, files: [`${id}.txt`], estTokens: 10, context: ['SPEC.md'] });
  const swarm = createSwarm(dir, { models: { orch: orch([d('t1'), d('t2'), { text: 'end' }]), flint } });
  await swarm.generate({ prompt: 'go' });
  assert.ok(prompts[0].includes('THE-SPEC-BODY') && prompts[2].includes('THE-SPEC-BODY'), 'both tasks got the spec');
  assert.ok(prompts[1].includes('unchanged since you last read SPEC.md'), 'read_file elided');
});

test('a worker with no write by half its step cap gets a system nudge', async () => {
  const prompts: string[] = [];
  const flint = scripted('flint', (i, p) => { prompts.push(p); return i < 14 ? call('list_files', {}) : { text: 'STATUS: failed blocked' }; });
  const swarm = createSwarm(await tmp(), { models: { orch: orch([call('dispatch', { id: 't', kind: 'feature', goal: 'x', files: ['x.ts'], estTokens: 10 }), { text: 'end' }]), flint } });
  await swarm.generate({ prompt: 'go' });
  assert.ok(!prompts[11].includes('without changing any file'));
  assert.match(prompts[12], /From: system[\s\S]*used 12 of 25 steps without changing any file/);
  assert.ok(prompts[13].includes('used 12 of 25 steps'), 'injected message persists into later steps');
});

test('mailbox: worker -> orch, human -> running worker, inbox file -> orch; delivered at step boundaries', async () => {
  const dir = await tmp();
  const inbox = join(dir, 'run.inbox.jsonl');
  await writeFile(inbox, JSON.stringify({ to: 'orch', from: 'claude', text: 'hello from the inbox' }) + '\n');
  const journal: JournalEvent[] = [];
  const oPrompts: string[] = [];
  const wPrompts: string[] = [];
  let swarm!: ReturnType<typeof createSwarm>;
  const flint = scripted('flint', (i, p) => {
    wPrompts.push(p);
    if (i === 0) { swarm.controls.send('task:t', 'use tabs please'); return call('send_message', { to: 'orch', text: 'spec says X but Y exists' }); }
    return i === 1 ? call('list_files', {}) : { text: 'STATUS: ok' };
  });
  swarm = createSwarm(dir, {
    inbox, journal: (e) => journal.push(e),
    models: { orch: orch([call('dispatch', { id: 't', kind: 'feature', goal: 'x', files: ['x.ts'], estTokens: 10 }), { text: 'end' }], oPrompts), flint },
  });
  await swarm.generate({ prompt: 'go' });
  assert.match(oPrompts[0], /\[MESSAGES\][\s\S]*From: external:claude[\s\S]*hello from the inbox/);
  assert.ok(!wPrompts[0].includes('use tabs please'), 'not delivered mid-step');
  assert.match(wPrompts[1], /From: human\\nTo: task:t[\s\S]*use tabs please/);
  assert.match(oPrompts[1], /From: task:t\\nTo: orch[\s\S]*spec says X but Y exists/);
  const states = journal.filter((e) => e.type === 'msg').map((e) => e.type === 'msg' && `${e.to}:${e.state}`);
  assert.deepEqual(states.sort(), ['orch:delivered', 'orch:delivered', 'orch:queued', 'orch:queued', 'task:t:delivered', 'task:t:queued']);
});

test('modes: plan refuses dispatch; ask gates every file write; setMode emits + journals', async () => {
  const dir = await tmp();
  const events: SwarmEvent[] = [];
  const journal: JournalEvent[] = [];
  const asked: string[] = [];
  const gate = { checkpoint: async () => {}, beforeTool: async (_a: unknown, tool: string) => { asked.push(tool); return { approve: tool !== 'write_file' }; } };
  const results: string[] = [];
  const flint = scripted('flint', (i, p) => (i === 0 ? call('write_file', { path: 'x.txt', content: 'x' }) : (results.push(p), { text: 'STATUS: failed denied' })));
  const disp = call('dispatch', { id: 't', kind: 'boilerplate', goal: 'x', files: ['x.txt'], estTokens: 10 });
  const prompts: string[] = [];
  const swarm = createSwarm(dir, { gate, mode: 'plan', emit: (e) => events.push(e), journal: (e) => journal.push(e), models: { orch: orch([disp, { text: 'plan shown' }, disp, { text: 'end' }], prompts), flint } });
  await swarm.generate({ prompt: 'plan it' });
  assert.ok(prompts[1].includes('REFUSED: plan mode'));
  swarm.controls.setMode('ask');
  assert.equal(swarm.controls.mode(), 'ask');
  await swarm.generate({ prompt: 'do it' });
  assert.deepEqual(asked, ['write_file']);
  assert.ok(results[0].includes('DENIED by the human reviewer: do not create x.txt'));
  await assert.rejects(access(join(dir, 'x.txt')));
  assert.ok(events.some((e) => e.type === 'mode' && e.mode === 'ask'));
  assert.equal(pendingCount(journal), 0, 'approval request + denial both journaled');
  assert.ok(journal.some((e) => e.type === 'approval' && e.state === 'request') && journal.some((e) => e.type === 'mode'));
});

test('pendingCount: unresolved approvals and questions; zero once the run ended', () => {
  const ev: JournalEvent[] = [
    { type: 'approval', id: 'a', agent: 'orch', tool: 'run_command', why: 'x', state: 'request' },
    { type: 'ask', id: 'q', question: '?', state: 'request' },
    { type: 'ask', id: 'q', question: '?', state: 'answered' },
  ];
  assert.equal(pendingCount(ev), 1);
  assert.equal(pendingCount([...ev, { type: 'end', status: 'done' }]), 0);
});
