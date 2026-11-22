// Append-only run journal (JSONL) — the durable record `dot-agent-persist swarm ps|tail|resume` reads.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const JOURNAL_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'tmux-agents', 'swarm');

export type JournalEvent =
  | { type: 'start'; dir: string; mode: string; pid: number; resumeOf?: string }
  | { type: 'user'; text: string }
  | { type: 'step'; text: string; tools: string[] }
  | { type: 'dispatch'; id: string; kind: string; worker: string; reason: string; attempt: number; files: string[] }
  | { type: 'worker'; id: string; line: string }
  | { type: 'result'; id: string; status: 'ok' | 'failed' | 'stuck'; summary: string }
  | { type: 'error'; message: string }
  | { type: 'end'; status: 'done' | 'error' };

export type Journal = (e: JournalEvent) => void;

export function openJournal(runId: string): Journal {
  mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
  const path = join(JOURNAL_DIR, `${runId}.jsonl`);
  return (e) => appendFileSync(path, JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 });
}

export function readJournal(runId: string): (JournalEvent & { t: string })[] {
  return readFileSync(join(JOURNAL_DIR, `${runId}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Restore-from-evidence summary for a resumed run: what was asked, what each task reported, where it stopped.
export function summarize(events: JournalEvent[]): string {
  const asks = events.filter((e) => e.type === 'user').map((e) => `- ${e.text.slice(0, 300)}`);
  const results = new Map<string, string>();
  for (const e of events) if (e.type === 'result') results.set(e.id, `- ${e.id} [${e.status}]: ${e.summary.slice(0, 400)}`);
  const lastStep = [...events].reverse().find((e) => e.type === 'step' && e.text);
  const ended = events.some((e) => e.type === 'end');
  return [
    'User requests so far:', ...(asks.length ? asks : ['- (none recorded)']),
    'Task results:', ...(results.size ? results.values() : ['- (none)']),
    `Last orchestrator message: ${lastStep && lastStep.type === 'step' ? lastStep.text.slice(0, 800) : '(none)'}`,
    ended ? 'The previous run ended normally.' : 'The previous run stopped without finishing; check the workspace before redoing work.',
  ].join('\n');
}
