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
      flint: scripted('flint', [{ tools: [{ name: 'read_file', input: { path: 'a.txt' } }] }, { text: '' }]),
      beam: scripted('beam', [{ text: 'STATUS: ok' }]),
    },
  });
  await swarm.generate({ prompt: 'go' });
  const results = journal.filter((e) => e.type === 'result');
  assert.match(results[0].type === 'result' ? results[0].summary : '', /NO FINAL REPORT.*1 tool calls/s);
  const dispatches = journal.filter((e) => e.type === 'dispatch');
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches[1].type === 'dispatch' && dispatches[1].worker === 'beam' && dispatches[1].files[0] === 'a.txt');
  assert.ok(journal.some((e) => e.type === 'worker' && /→ read_file: .*one/.test(e.line)));
});
