// Deterministic routing + file leases. Pure logic, no model calls — this is the part you test.

export type Worker = 'beam' | 'deepseek' | 'minimax';
export const VISION_WORKERS: Worker[] = ['deepseek', 'minimax'];
export const FIRST_LINE = ['beam', 'deepseek'] as const; // the orchestrator may only `prefer` these; MiniMax is final-attempt/override only
export type TaskKind =
  | 'explore' | 'architecture' | 'refactor' | 'terminal' // long-horizon
  | 'bugfix' | 'test' | 'boilerplate' | 'feature';        // scoped

export interface Task {
  id: string;
  kind: TaskKind;
  goal: string;
  files: string[];     // files the worker may WRITE (its lease)
  estTokens: number;   // orchestrator's estimate of context the task needs
  attempt: number;     // 1-based
  prefer?: typeof FIRST_LINE[number]; // orchestrator's hint; hard rules below override it
  force?: Worker;      // explicit human override from a UI; beats every rule
  visual?: boolean;    // task needs to look at screenshots/designs/images: only the vision models can
}

export const MODELS: Record<Worker, string> = {
  beam: 'reflection/beam-free',  // 1,048,576 ctx, 131k out, free tier = rate-limited
  deepseek: 'deepseek/deepseek-v4.1-flash-1017', // paid $0.02/$0.29 per M (51% off list, 2026-11-23), 1M ctx assumed same as v4.1-flash
  minimax: 'minimax/minimax-m3.1-flash',   // paid $0.15/$0.60 per M, 1M ctx, vision: scoped tasks (replaced qwen3.8-27b 2026-11-23)
};

const BIG_TASK_TOKENS = 180_000; // above this a task goes to the heavy worker (was Flint's context budget; Flint dropped 2026-11-23 as unreliable)
const LONG_HORIZON: TaskKind[] = ['explore', 'architecture', 'refactor', 'terminal'];
export const MAX_ATTEMPTS = 3;

export function route(t: Task): { worker: Worker; reason: string } {
  if (t.force) return { worker: t.force, reason: `manual override: user chose ${t.force}` };
  if (t.attempt > MAX_ATTEMPTS) throw new Error(`task ${t.id}: attempt budget exhausted`);
  const big = t.estTokens > BIG_TASK_TOKENS || LONG_HORIZON.includes(t.kind) || t.files.length > 5;
  // Beam is text-only, so visual tasks start on a paid vision model and swap to the other one on the final attempt.
  if (t.visual) {
    const first: Worker = big ? 'deepseek' : 'minimax';
    const w: Worker = t.attempt >= MAX_ATTEMPTS ? (first === 'minimax' ? 'deepseek' : 'minimax') : first;
    return { worker: w, reason: `visual ${big ? 'large/long-horizon' : 'scoped'} task${w === first ? '' : ', final attempt on the other vision model'}` };
  }
  // Ladder: scoped Beam -> DeepSeek -> MiniMax; large DeepSeek -> DeepSeek -> MiniMax. The final attempt is a different family.
  if (t.attempt >= MAX_ATTEMPTS) return { worker: 'minimax', reason: `final attempt on a different model family: ${big ? 'large/long-horizon' : 'scoped'} task` };
  if (t.estTokens > BIG_TASK_TOKENS) return { worker: 'deepseek', reason: 'context exceeds the scoped-task budget' };
  if (LONG_HORIZON.includes(t.kind)) return { worker: 'deepseek', reason: `${t.kind} is long-horizon` };
  if (t.files.length > 5) return { worker: 'deepseek', reason: 'touches >5 files' };
  if (t.attempt >= 2) return { worker: 'deepseek', reason: 'escalation after a failed Beam attempt' };
  return { worker: t.prefer ?? 'beam', reason: 'scoped task' };
}

// One writer per file. Overlapping leases are rejected, so two workers never edit the same file concurrently.
export class Leases {
  private owner = new Map<string, string>(); // file -> taskId
  acquire(taskId: string, files: string[]): string[] {
    const clash = files.filter((f) => this.owner.has(f) && this.owner.get(f) !== taskId);
    if (clash.length === 0) files.forEach((f) => this.owner.set(f, taskId));
    return clash;
  }
  release(taskId: string) {
    for (const [f, id] of this.owner) if (id === taskId) this.owner.delete(f);
  }
  holds(taskId: string, file: string) { return this.owner.get(file) === taskId; }
  ownerOf(file: string) { return this.owner.get(file); }
}
