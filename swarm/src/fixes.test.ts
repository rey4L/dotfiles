// Regression tests for run-3 findings: blank worker reports, escalation losing its files, untraceable tool output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwarm } from './swarm.ts';
import { scripted } from './mock.ts';
import type { JournalEvent } from './journal.ts';

const disp = (files: string[]) => ({ tools: [{ name: 'dispatch', input: { id: 'fix', kind: 'bugfix', goal: 'same goal', files, estTokens: 1000 } }] });

test('blank worker text -> NO FINAL REPORT summary; escalation inherits files; tool output tail journaled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-fix-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const journal: JournalEvent[] = [];
  const swarm = createSwarm(dir, {
    journal: (e) => journal.push(e),
    models: {
      orch: scripted('orch', [disp(['a.txt']), disp([]), { text: 'done' }]),
      beam: scripted('beam', [{ tools: [{ name: 'read_file', input: { path: 'a.txt' } }] }, { text: '' }]),
      deepseek: scripted('deepseek', [{ text: 'STATUS: ok' }]),
    },
  });
  await swarm.generate({ prompt: 'go' });
  const results = journal.filter((e) => e.type === 'result');
  assert.match(results[0].type === 'result' ? results[0].summary : '', /NO FINAL REPORT.*1 tool calls/s);
  const dispatches = journal.filter((e) => e.type === 'dispatch');
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches[1].type === 'dispatch' && dispatches[1].worker === 'deepseek' && dispatches[1].files[0] === 'a.txt');
  assert.ok(journal.some((e) => e.type === 'worker' && /→ read_file: .*one/.test(e.line)));
});

test('step caps end with a forced report, not silence (orchestrator + worker)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-cap-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const budget = (p: string) => p.includes('Step budget used up');
  const swarm = createSwarm(dir, {
    journal: () => {},
    models: {
      // orchestrator: one dispatch, then loops on status forever unless told the budget is used up
      orch: scripted('orch', (i, p) => (budget(p) ? { text: 'ORCH REPORT' } : i === 0 ? disp(['a.txt']) : { tools: [{ name: 'status', input: {} }] })),
      beam: scripted('beam', (_i, p) => (budget(p) ? { text: 'STATUS: failed\nWORKER REPORT' } : { tools: [{ name: 'list_files', input: {} }] })),
    },
  });
  const r = await swarm.generate({ prompt: 'go' });
  assert.equal(r.text, 'ORCH REPORT');
  assert.equal(r.steps.length, 25);
  const status = r.steps.flatMap((s) => s.toolResults).find((t) => t.toolName === 'dispatch');
  assert.match(JSON.stringify(status?.output), /WORKER REPORT/);
});

test('reworded retry of the same task still escalates; success resets the count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-att-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const journal: JournalEvent[] = [];
  const d = (id: string, goal: string) => ({ tools: [{ name: 'dispatch', input: { id, kind: 'feature', goal, files: ['a.txt'], estTokens: 1000 } }] });
  const swarm = createSwarm(dir, {
    journal: (e) => journal.push(e),
    models: {
      orch: scripted('orch', [d('s', 'write a'), d('s', 'write a, and also fix the tail'), d('s-again', 'new work on a'), { text: 'done' }]),
      beam: scripted('beam', [{ text: 'STATUS: failed' }, { text: 'STATUS: ok' }]),
      deepseek: scripted('deepseek', [{ text: 'STATUS: ok' }]),
    },
  });
  await swarm.generate({ prompt: 'go' });
  const ds = journal.filter((e) => e.type === 'dispatch').map((e) => (e.type === 'dispatch' ? `${e.worker}:${e.attempt}` : ''));
  assert.deepEqual(ds, ['beam:1', 'deepseek:2', 'beam:1']);
});

test('plan accepts tasks sent as {id, goal} objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-plan-'));
  const swarm = createSwarm(dir, {
    journal: () => {},
    models: { orch: scripted('orch', [{ tools: [{ name: 'plan', input: { batches: [{ id: 'b1', goal: 'g', tasks: [{ id: 't1', goal: 'do x' }, 'plain'] }] } }] }, { text: 'done' }]) },
  });
  const r = await swarm.generate({ prompt: 'go' });
  const out = JSON.stringify(r.steps[0].toolResults[0]?.output);
  assert.match(out, /Plan saved.*t1: do x; plain/);
});

test('long worker report keeps its STATUS verdict in the summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-long-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const journal: JournalEvent[] = [];
  const swarm = createSwarm(dir, {
    journal: (e) => journal.push(e),
    models: {
      orch: scripted('orch', [disp(['a.txt']), { text: 'done' }]),
      beam: scripted('beam', [{ text: `STATUS: ok\n${'x'.repeat(3000)}` }]),
    },
  });
  await swarm.generate({ prompt: 'go' });
  const r = journal.find((e) => e.type === 'result');
  assert.ok(r && r.type === 'result' && r.status === 'ok' && /^STATUS: ok/.test(r.summary));
});

test('a dispatch rejected for a lease conflict does not count as an attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-clash-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const journal: JournalEvent[] = [];
  const d = (id: string, goal: string) => ({ name: 'dispatch', input: { id, kind: 'feature', goal, files: ['a.txt'], estTokens: 1000 } });
  const swarm = createSwarm(dir, {
    journal: (e) => journal.push(e),
    models: {
      orch: scripted('orch', [{ tools: [d('first', 'g1'), d('clash', 'g2')] }, { tools: [d('clash2', 'g2 again')] }, { text: 'done' }]),
      beam: scripted('beam', () => ({ delayMs: 20, text: 'STATUS: ok' })),
    },
  });
  await swarm.generate({ prompt: 'go' });
  const ds = journal.filter((e) => e.type === 'dispatch').map((e) => (e.type === 'dispatch' ? `${e.id}:${e.worker}:${e.attempt}` : ''));
  assert.deepEqual(ds, ['first:beam:1', 'clash2:beam:1']);
});
