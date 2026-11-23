// Append-only run journal (JSONL) — the durable record `dot-agent-persist swarm ps|tail|resume` reads.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const JOURNAL_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'tmux-agents', 'swarm');

export type JournalEvent =
  | { type: 'start'; dir: string; mode: string; pid: number; resumeOf?: string }
  | { type: 'user'; text: string }
  | { type: 'step'; text: string; tools: string[]; usage?: { in: number; out: number }; errors?: string[] }
  | { type: 'dispatch'; id: string; kind: string; worker: string; reason: string; attempt: number; files: string[] }
  | { type: 'worker'; id: string; line: string }
  | { type: 'result'; id: string; status: 'ok' | 'failed' | 'stuck' | 'cancelled'; summary: string; tokens?: { in: number; out: number } }
  | { type: 'plan'; batches: { id: string; goal: string; tasks: string[] }[]; verify?: string }
  | { type: 'batch'; id: string; index: number; total: number; goal: string; status: 'start' | 'done' | 'failed'; summary?: string }
  | { type: 'msg'; id: string; from: string; to: string; text: string; inReplyTo?: string; state: 'queued' | 'delivered' }
  | { type: 'approval'; id: string; agent: string; tool: string; why: string; state: 'request' | 'approved' | 'denied' }
  | { type: 'ask'; id: string; question: string; state: 'request' | 'answered' }
  | { type: 'mode'; mode: string }
  | { type: 'error'; message: string }
  | { type: 'end'; status: 'done' | 'error' };

export type Journal = (e: JournalEvent) => void;
export const inboxPath = (runId: string) => join(JOURNAL_DIR, `${runId}.inbox`);

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
  const batches = events.filter((e) => e.type === 'batch').map((e) => e.type === 'batch' ? `- batch ${e.index + 1}/${e.total} ${e.id} [${e.status}]: ${e.status === 'start' ? e.goal.slice(0, 300) : (e.summary ?? '').slice(0, 400)}` : '');
  const lastStep = [...events].reverse().find((e) => e.type === 'step' && e.text);
  const ended = events.some((e) => e.type === 'end');
  return [
    'User requests so far:', ...(asks.length ? asks : ['- (none recorded)']),
    ...(batches.length ? ['Batch plan progress (CLI/TUI resumes restore the plan: continue the open batch and call batch_done; only if it says "No open batch", call plan with ONLY the batches not done):', ...batches] : []),
    'Task results:', ...(results.size ? results.values() : ['- (none)']),
    `Last orchestrator message: ${lastStep && lastStep.type === 'step' ? lastStep.text.slice(0, 800) : '(none)'}`,
    ended ? 'The previous run ended normally.' : 'The previous run stopped without finishing; check the workspace before redoing work.',
  ].join('\n');
}

// Things waiting on the human (approvals + questions not yet resolved): the "needs you" count for run lists.
export function pendingCount(events: JournalEvent[]): number {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type !== 'approval' && e.type !== 'ask') continue;
    const k = `${e.type}:${e.id}`;
    if (e.state === 'request') open.add(k); else open.delete(k);
  }
  return events.some((e) => e.type === 'end') ? 0 : open.size;
}

// Engine state a resumed run continues from (not just the text summary): plan position and attempt counts.
export type ResumeState = {
  plan?: { batches: { id: string; goal: string; tasks: string[] }[]; verify?: string };
  batchIdx: number;
  halted: boolean;
  batchLog: string[];
  attempts: Map<string, number>; // task id -> attempts that did not end ok
  files: Map<string, string[]>; // task id -> files of the last attempt
  ledger: Map<string, { worker: string; status: string; summary: string }>;
};
export function resumeState(events: JournalEvent[]): ResumeState {
  const st: ResumeState = { batchIdx: 0, halted: false, batchLog: [], attempts: new Map(), files: new Map(), ledger: new Map() };
  const worker = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'plan') Object.assign(st, { plan: { batches: e.batches, verify: e.verify }, batchIdx: 0, halted: false, batchLog: [] });
    else if (e.type === 'batch' && e.status === 'done') { st.batchIdx = e.index + 1; st.batchLog.push(`- ${e.id} [done]: ${(e.summary ?? '').slice(0, 600)}`); }
    else if (e.type === 'batch' && e.status === 'failed') st.halted = true;
    else if (e.type === 'dispatch') { st.attempts.set(e.id, e.attempt); st.files.set(e.id, e.files); worker.set(e.id, e.worker); }
    else if (e.type === 'result') {
      st.ledger.set(e.id, { worker: worker.get(e.id) ?? '?', status: e.status, summary: e.summary });
      if (e.status === 'ok') st.attempts.delete(e.id);
    }
  }
  return st;
}
