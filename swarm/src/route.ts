// Deterministic routing + file leases. Pure logic, no model calls — this is the part you test.

export type Worker = 'beam' | 'flint' | 'deepseek' | 'haiku';
export const VISION_WORKERS: Worker[] = ['deepseek', 'haiku'];
export const FREE_WORKERS = ['beam', 'flint'] as const; // the orchestrator may only `prefer` these; paid ones are escalation/override only
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
  prefer?: typeof FREE_WORKERS[number]; // orchestrator's hint; hard rules below override it
  force?: Worker;      // explicit human override from a UI; beats every rule
  visual?: boolean;    // task needs to look at screenshots/designs/images: only the vision models can
}

export const MODELS: Record<Worker, string> = {
  beam: 'reflection/beam-free',  // 1,048,576 ctx, 131k out, free tier = rate-limited
  flint: 'recursive/flint-v1.0', // 262,144 ctx, p50 ~0.85s TTFT on the gateway
  deepseek: 'deepseek/deepseek-v4.1-flash-1017', // paid $0.02/$0.29 per M (51% off list, 2026-11-23), 1M ctx assumed same as v4.1-flash
  haiku: 'anthropic/claude-haiku-5.5',      // paid $0.10/$0.50 per M, 1M ctx: last resort for scoped tasks
};

const FLINT_CTX_BUDGET = 180_000; // 262k minus room for reasoning + output
const LONG_HORIZON: TaskKind[] = ['explore', 'architecture', 'refactor', 'terminal'];
export const MAX_ATTEMPTS = 3;

export function route(t: Task): { worker: Worker; reason: string } {
  if (t.force) return { worker: t.force, reason: `manual override: user chose ${t.force}` };
  if (t.attempt > MAX_ATTEMPTS) throw new Error(`task ${t.id}: attempt budget exhausted`);
  const big = t.estTokens > FLINT_CTX_BUDGET || LONG_HORIZON.includes(t.kind) || t.files.length > 5;
  // Beam/Flint are text-only, so visual tasks start on a paid vision model and swap to the other one on the final attempt.
  if (t.visual) {
    const first: Worker = big ? 'deepseek' : 'haiku';
    const w: Worker = t.attempt >= MAX_ATTEMPTS ? (first === 'haiku' ? 'deepseek' : 'haiku') : first;
    return { worker: w, reason: `visual ${big ? 'large/long-horizon' : 'scoped'} task${w === first ? '' : ', final attempt on the other vision model'}` };
  }
  // Free models get two tries; only the final attempt spends money, on a different model family than the one that failed.
  if (t.attempt >= MAX_ATTEMPTS) return big
    ? { worker: 'deepseek', reason: 'final attempt after free models failed: large/long-horizon task' }
    : { worker: 'haiku', reason: 'final attempt after free models failed: scoped task' };
  if (t.estTokens > FLINT_CTX_BUDGET) return { worker: 'beam', reason: 'context exceeds Flint budget' };
  if (LONG_HORIZON.includes(t.kind)) return { worker: 'beam', reason: `${t.kind} is long-horizon` };
  if (t.files.length > 5) return { worker: 'beam', reason: 'touches >5 files' };
  if (t.attempt >= 2) return { worker: 'beam', reason: 'escalation after a failed Flint attempt' };
  return { worker: t.prefer ?? 'flint', reason: 'scoped task' };
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
