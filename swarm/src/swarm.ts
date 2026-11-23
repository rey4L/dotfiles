// Orchestrator (Ampersand) -> workers (Beam / Flint) over Vercel AI Gateway.
// Auth: AI_GATEWAY_API_KEY (env or swarm/.env), or OIDC via `vercel env pull`.
import { ToolLoopAgent, tool, isStepCount, gateway, wrapLanguageModel, type ModelMessage, type LanguageModel, type StepResult, type ToolSet } from 'ai';
import { z } from 'zod';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { route, Leases, MODELS, FREE_WORKERS, VISION_WORKERS, type Task, type Worker } from './route.ts';
import { runSandboxed } from './sandbox.ts';
import type { Journal, ResumeState } from './journal.ts';
import type { AgentId, Emit, Gate, Mode } from './events.ts';
import { createMailbox, envelope, type Address } from './mailbox.ts';

export const ORCHESTRATOR_MODEL = 'humansand/ampersand-v0.1';
export const ORCHESTRATOR_CONTEXT = 1_000_000;
export const CONTEXT: Record<'orch' | Worker, number> = { orch: ORCHESTRATOR_CONTEXT, beam: 1_048_576, flint: 262_144, deepseek: 1_048_576, qwen: 262_144 };
const MAX_DISPATCHES = 12; // per batch (a run without a plan is one batch)
const MAX_BATCHES = 8;
const ORCH_STEPS_PER_BATCH = 25; // orchestrator turns are slow (p50 ~8s); keep each batch's loop short
const WATCHDOG_MS = 15 * 60_000; // a worker with no finished step for this long is aborted as stuck
const SNAPSHOT_MAX = 200_000; // edit snapshots above this size carry hashes only

const WORKER_INSTRUCTIONS: Record<Worker, string> = {
  beam: 'You are the long-horizon engineer. Explore broadly, reason about architecture, then make coherent multi-file changes.',
  flint: 'You are the fast, scoped engineer. Make the smallest correct change to the leased files. Do not explore beyond what the task needs.',
  deepseek: 'You are the long-horizon engineer with vision. Explore broadly, reason about architecture, then make coherent multi-file changes.',
  qwen: 'You are the scoped engineer with vision. Make the smallest correct change to the leased files.',
};
const VISION_HOWTO =
  'You can see images: view_image shows you a PNG/JPEG/WebP/GIF from the workspace. To look at a page, screenshot it with run_command, e.g. ' +
  '`mkdir -p .shots && chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=1400,900 --virtual-time-budget=5000 --screenshot=.shots/home.png <file:///abs/path.html or http://127.0.0.1:PORT/>` ' +
  '(start a dev/preview server in the SAME command, in the background, if you need one; there is no network), then view_image .shots/home.png. ' +
  'Check your UI changes visually before reporting ok. For diagrams, write SVG (or an HTML page with inline SVG), screenshot it and check labels do not overlap or clip. Delete .shots/ when done.';
// Last step before a step cap: no tools, so the loop ends with a report instead of silence (run 2026-11-22T17-52: orchestrator
// spent its 50 steps on read_file/status and the TUI showed "Done" with nothing; workers ended as "NO FINAL REPORT").
const finalStep = (messages: ModelMessage[], what: string) => ({
  toolChoice: 'none' as const,
  messages: [...messages, { role: 'user' as const, content: `Step budget used up: no more tool calls. Write your final report now: ${what}` }],
});
const STEP_CAP: Record<Worker, number> = { beam: 40, flint: 25, deepseek: 40, qwen: 25 }; // loop guard; Flint was 15 and ran out on most feature tasks (2026-11-22)

type Progress = { worker?: Worker; reason?: string; attempt?: number; log: string[]; done: boolean; summary?: string };
type DispatchInput = Omit<Task, 'attempt' | 'force'> & { context?: string[] };

export interface SwarmOptions {
  journal?: Journal;
  resumeContext?: string;
  emit?: Emit; // live UI events
  gate?: Gate; // approvals + pause
  askUser?: (question: string, signal?: AbortSignal) => Promise<string>; // enables the ask_user tool
  models?: Partial<Record<'orch' | Worker, LanguageModel>>; // test/mock injection
  resume?: ResumeState; // engine state of the run being resumed (plan position, attempts, ledger)
  inbox?: string; // path of <runId>.inbox for `swarm send`
  mode?: Mode;
  retryDelayMs?: number; // backoff before retrying a worker after a transient provider error (tests: 0)
}
const CONTEXT_FILE_MAX = 60_000; // per reference file inlined into a worker prompt
const CONTEXT_TOTAL_MAX = 160_000;
// Provider hiccups ("inference service temporarily unavailable", 5xx, deadlines) are not the worker's fault: retry once, same worker,
// without counting an attempt (runs 2026-11-22T18-03 and 19-17: two Beam runs died this way and went straight to paid Haiku).
const TRANSIENT = /unavailable|overloaded|temporar|deadline|timed? ?out|ECONNRESET|socket hang up|fetch failed|\b5\d\d\b/i;
const isTransient = (e: unknown) => {
  const err = e as { statusCode?: number; message?: string };
  return (err?.statusCode ?? 0) >= 500 || TRANSIENT.test(err?.message ?? '');
};

export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const tail = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(-400);

export function createSwarm(rootDir: string, opts: SwarmOptions = {}) {
  const log: Journal = opts.journal ?? (() => {});
  const emit: Emit = opts.emit ?? (() => {});
  const ROOT = resolve(rootDir);
  const leases = new Leases();
  const ledger = new Map<string, { worker: string; status: string; summary: string }>(opts.resume?.ledger);
  const seen = new Map<string, number>(); // task id / lease set -> attempts (loop guard); cleared when the task succeeds
  const prevFiles = new Map<string, string[]>(); // task id -> files of the last attempt
  for (const [id, n] of opts.resume?.attempts ?? []) seen.set(`id:${id}`, n);
  for (const [id, f] of opts.resume?.files ?? []) if (seen.has(`id:${id}`)) prevFiles.set(`id:${id}`, f);
  const tasks = new Map<string, DispatchInput>(); // for manual re-dispatch
  const running = new Map<string, AbortController>(); // taskId -> per-worker cancel
  let dispatches = 0;
  let mode: Mode = opts.mode ?? 'auto';
  const mailbox = createMailbox(log, emit, opts.inbox, (to) => running.has(to.slice(5)));
  // Journal approvals so a background run's "needs you" count survives (pendingCount in journal.ts).
  const gate: Gate | undefined = opts.gate && {
    checkpoint: opts.gate.checkpoint.bind(opts.gate),
    async beforeTool(agent, tool, input, why, signal) {
      const id = randomUUID().slice(0, 8);
      log({ type: 'approval', id, agent, tool, why, state: 'request' });
      const d = await opts.gate!.beforeTool(agent, tool, input, why, signal).catch((e) => { log({ type: 'approval', id, agent, tool, why, state: 'denied' }); throw e; });
      log({ type: 'approval', id, agent, tool, why, state: d.approve ? 'approved' : 'denied' });
      return d;
    },
  };
  const contextCache = new Map<string, { mtime: number; text: string }>(); // reference files shared by every task in this run
  // Batch plan: a big request is split into batches; each gets a fresh dispatch budget and a compacted orchestrator context.
  type Batch = { id: string; goal: string; tasks: string[] };
  let plan: { batches: Batch[]; verify?: string } | undefined = opts.resume?.plan;
  let batchIdx = opts.resume?.batchIdx ?? 0;
  let verifyFails = 0;
  let halted = opts.resume?.halted ?? false; // verify failed twice: no more dispatches until the human steps in
  let compactPending = false;
  let turnBatchBase = 0;
  const batchLog: string[] = [...(opts.resume?.batchLog ?? [])];
  const batchEvent = (status: 'start' | 'done' | 'failed', summary?: string) => {
    const b = plan!.batches[batchIdx];
    const e = { type: 'batch' as const, id: b.id, index: batchIdx, total: plan!.batches.length, goal: b.goal, status, summary };
    log(e);
    emit(e);
  };
  let beamBusy: Promise<void> = Promise.resolve(); // beam-free is rate-limited: one Beam worker at a time (only with a UI)

  // Models: plain gateway ids for the TUI (unchanged); wrapped to report rate limits when a UI listens.
  const model = (who: 'orch' | Worker): LanguageModel => {
    const id = who === 'orch' ? ORCHESTRATOR_MODEL : MODELS[who];
    if (opts.models?.[who]) return opts.models[who]!;
    if (!opts.emit) return id;
    const note = (e: unknown) => {
      const err = e as { statusCode?: number; message?: string };
      if (err?.statusCode === 429 || /rate.?limit/i.test(err?.message ?? '')) emit({ type: 'ratelimit', model: id, message: err.message ?? '429' });
    };
    return wrapLanguageModel({
      model: gateway(id),
      middleware: {
        wrapGenerate: async ({ doGenerate }) => { try { return await doGenerate(); } catch (e) { note(e); throw e; } },
        wrapStream: async ({ doStream }) => { try { return await doStream(); } catch (e) { note(e); throw e; } },
      },
    });
  };

  const stepEvent = (agent: AgentId, who: 'orch' | Worker, step: StepResult<ToolSet>) => {
    const u = step.usage;
    emit({
      type: 'step.end', agent, text: step.text, model: step.model.modelId,
      usage: { in: u.inputTokens ?? 0, out: u.outputTokens ?? 0, reasoning: u.outputTokenDetails?.reasoningTokens, cacheRead: u.inputTokenDetails?.cacheReadTokens },
      ms: step.performance?.stepTimeMs ?? 0,
      contextPct: Math.round(((u.inputTokens ?? 0) / CONTEXT[who]) * 1000) / 10,
      gateway: step.providerMetadata?.gateway, // shortcut: passed raw, shape unverified until seen in a real gateway response
    });
  };

  const safe = makeSafe(ROOT);
  const fsTools = (taskId: string, agent: AgentId, preRead?: Map<string, number>) =>
    instrument(makeFsTools(ROOT, leases, taskId, { emit, gate, agent, mode: () => mode, preRead }), agent, emit);

  // Spec/reference files the orchestrator names in `context`: read once per run (cache keyed by mtime), inlined in the prompt.
  // Workers used to re-read the same spec 8-11x across tasks and hit their step cap before writing (run 2026-11-22T18-03).
  async function contextBlock(paths: string[]): Promise<{ text: string; preRead: Map<string, number> }> {
    const preRead = new Map<string, number>();
    const parts: string[] = [];
    let total = 0;
    for (const p of paths) {
      try {
        const abs = safe(p);
        const mtime = (await stat(abs)).mtimeMs;
        let c = contextCache.get(abs);
        if (c?.mtime !== mtime) contextCache.set(abs, (c = { mtime, text: await readFile(abs, 'utf8') }));
        const room = Math.min(CONTEXT_FILE_MAX, CONTEXT_TOTAL_MAX - total);
        if (room <= 0) { parts.push(`=== ${p} === (omitted: context budget used; read it yourself if needed)`); continue; }
        const body = c.text.length <= room ? c.text : `${c.text.slice(0, room)}\n… [truncated at ${room} of ${c.text.length} chars; read_file for the rest]`;
        total += body.length;
        parts.push(`=== ${p} ===\n${body}`);
        if (c.text.length <= room) preRead.set(abs, mtime); // fully shown: a read_file of it is elided
      } catch (e) {
        parts.push(`=== ${p} === (unreadable: ${(e as Error).message})`);
      }
    }
    return { text: parts.length ? `\n\nReference files, already read for you (do not read them again):\n${parts.join('\n\n')}` : '', preRead };
  }

  const sendTool = (from: AgentId) => tool({
    description: from === 'orch'
      ? 'Send a message to a RUNNING worker (to: "task:<id>") to steer it mid-task, or to the human (to: "human") as a non-blocking note. Delivered at the worker\'s next step.'
      : 'Send a short message to the orchestrator (to: "orch") or the human (to: "human") without ending your task, e.g. the spec is wrong or another file must change. Replies arrive as a new message at a later step.',
    inputSchema: z.object({ to: z.string(), text: z.string().min(1), inReplyTo: z.string().optional() }),
    execute: async ({ to, text, inReplyTo }) => {
      const dest = (to === 'orch' || to === 'human' || to.startsWith('task:') ? to : `task:${to}`) as Address;
      if (from !== 'orch' && dest.startsWith('task:')) return 'DENIED: workers message "orch" or "human" only.';
      const m = mailbox.send({ from, to: dest, text, inReplyTo });
      return `sent ${m.id} to ${m.to}`;
    },
  });
  // Drain this agent's mailbox into the step's messages (overrides persist into later steps in ai 7).
  const deliver = (to: Address, messages: ModelMessage[]) => {
    const got = mailbox.take(to);
    return got.length ? [...messages, { role: 'user' as const, content: `[MESSAGES]\n${envelope(got)}` }] : messages;
  };

  const runCommandTool = (agent: AgentId) => tool({
    description:
      'Run a shell command in the workspace inside a sandbox (no network, host read-only, only the workspace writable, 180s limit). ' +
      'Use it to run tests/linters. Returns exit code and the tail of the output.',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }, { abortSignal }) => runCommand(agent, command, abortSignal),
  });
  async function runCommand(agent: AgentId, command: string, abortSignal?: AbortSignal): Promise<string> {
    if (gate) {
      emit({ type: 'agent.status', agent, status: 'awaiting_approval', detail: command.slice(0, 120) });
      const d = await gate.beforeTool(agent, 'run_command', { command }, 'shell command', abortSignal);
      emit({ type: 'agent.status', agent, status: 'tool', detail: 'run_command' });
      if (!d.approve) return 'DENIED by the human reviewer. Do not retry this command; report it.';
      command = (d.input as { command?: string } | undefined)?.command ?? command;
    }
    return runSandboxed(ROOT, command, abortSignal);
  }

  // One worker run. Shared by the dispatch tool and manual re-dispatch from a UI.
  async function runWorker(input: DispatchInput, signal: AbortSignal | undefined, onProgress: (p: Progress) => void, force?: Worker): Promise<string> {
    const p: Progress = { log: [], done: false };
    // Attempts are counted per task id AND per lease set, not per goal text: Ampersand rewords retries, which used to reset
    // the count and hand a failed task back to Flint as "attempt 1" (run 2026-11-22T18-03: relay-sessions, twice).
    const idKey = `id:${input.id}`;
    // Escalations sometimes arrive with files=[] (run 3: Beam got no writable files); reuse the previous attempt's lease set.
    if (seen.has(idKey) && input.files.length === 0) input = { ...input, files: prevFiles.get(idKey) ?? [] };
    prevFiles.set(idKey, input.files);
    const keys = [idKey, ...(input.files.length ? [`files:${[...input.files].sort().join('|')}`] : [])];
    const attempt = Math.max(...keys.map((k) => seen.get(k) ?? 0)) + 1;
    let files: string[];
    try {
      files = input.files.map((f) => relative(ROOT, safe(f)));
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
    const clash = leases.acquire(input.id, files);
    if (clash.length) {
      emit({ type: 'lease.conflict', taskId: input.id, files: clash, heldBy: [...new Set(clash.map((f) => leases.ownerOf(f) ?? '?'))] });
      return `CONFLICT: ${clash.join(', ')} leased by another task. Sequence these tasks.`;
    }
    keys.forEach((k) => seen.set(k, attempt)); // only runs that actually start count: a rejected dispatch is not an attempt
    tasks.set(input.id, input);
    const agent: AgentId = `task:${input.id}`;
    const mine = new AbortController();
    running.set(input.id, mine);
    let worker: Worker = 'flint';
    let release = () => {};
    try {
      const task: Task = { ...input, files, attempt, force };
      const r = route(task);
      worker = r.worker;
      Object.assign(p, { worker, reason: r.reason, attempt });
      log({ type: 'dispatch', id: input.id, kind: input.kind, worker, reason: r.reason, attempt, files });
      emit({ type: 'dispatch', taskId: input.id, kind: input.kind, goal: input.goal, files, estTokens: input.estTokens, worker, reason: r.reason, attempt, forcedBy: force ? 'user' : undefined });
      onProgress({ ...p });

      if (worker === 'beam' && opts.emit) {
        emit({ type: 'agent.status', agent, status: 'queued', detail: 'waiting for the Beam slot (free-tier rate limit)' });
        const prev = beamBusy;
        beamBusy = new Promise<void>((r) => (release = r));
        await prev;
      }

      // Watchdog: abort the worker if no step finishes for WATCHDOG_MS.
      const dog = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => dog.abort(new Error(`watchdog: no progress for ${WATCHDOG_MS / 60_000} min`)), WATCHDOG_MS);
      };
      kick();
      const sig = AbortSignal.any([mine.signal, dog.signal, ...(signal ? [signal] : [])]);

      const ctx = await contextBlock(input.context ?? []);
      const tokens = { in: 0, out: 0 };
      let wrote = false;
      const cap = STEP_CAP[worker];
      const runOnce = async (retry: boolean): Promise<string> => {
        let wake = () => {};
        const agentLoop = new ToolLoopAgent({
          model: model(worker),
          instructions: `${WORKER_INSTRUCTIONS[worker]}
${attempt > 1 || retry ? 'Earlier attempts at this task failed or were interrupted: inspect the current workspace state before changing anything.\n' : ''}${VISION_WORKERS.includes(worker) ? VISION_HOWTO + '\n' : ''}You may only write: ${files.join(', ') || '(nothing — read-only task)'}.
Write early: read only what the change needs, then edit. Use web_search/web_fetch only for docs or facts the workspace cannot answer. If you are blocked (wrong spec, another file must change), tell the orchestrator with send_message or report STATUS: failed — do not keep exploring.
If you changed code and tests exist or you wrote them, run them with run_command and report the result; never claim tests pass without running them.
End with: STATUS: ok|failed, then a summary under 200 words (files changed, tests run + result, open risks).`,
          tools: {
            ...fsTools(input.id, agent, ctx.preRead),
            ...(VISION_WORKERS.includes(worker) ? instrument({ view_image: viewImageTool(ROOT) }, agent, emit) : {}),
            run_command: instrument({ run_command: runCommandTool(agent) }, agent, emit).run_command,
            send_message: sendTool(agent),
            // Run at the gateway ($0.75 per 1K calls each), not in the sandbox, which stays offline.
            web_search: gateway.tools.deepseekSearch(),
            web_fetch: gateway.tools.deepseekFetch(),
          },
          stopWhen: isStepCount(cap),
          maxRetries: 3, // beam-free is per-model rate-limited on the free tier
          // no stripReasoning here: Beam rejects requests without its earlier reasoning_content (run 2, 2026-11-21)
          prepareStep: async ({ stepNumber, messages }) => {
            if (gate) await gate.checkpoint(agent, sig);
            emit({ type: 'agent.status', agent, status: 'thinking' });
            if (stepNumber === Math.floor(cap / 2) && !wrote && files.length)
              mailbox.send({ from: 'system', to: agent, text: `You have used ${stepNumber} of ${cap} steps without changing any file. Stop exploring: make the change now, or report STATUS: failed with what blocks you.` });
            const msgs = deliver(agent, messages);
            if (stepNumber >= cap - 1) return finalStep(msgs, 'STATUS: ok|failed (failed if the task is not finished), what you changed, what is left, tests run + result.');
            return msgs === messages ? {} : { messages: msgs };
          },
          onStepEnd: (step) => {
            kick();
            tokens.in += step.usage.inputTokens ?? 0;
            tokens.out += step.usage.outputTokens ?? 0;
            for (const c of step.toolCalls) {
              const line = `${c.toolName} ${JSON.stringify(c.input).slice(0, 100)}`;
              p.log.push(line);
              log({ type: 'worker', id: input.id, line });
            }
            // Journal a short output tail per tool so `swarm tail` can explain odd behaviour (run 3: Beam looping on `echo hello`).
            for (const r of step.toolResults) {
              if ((r.toolName === 'write_file' || r.toolName === 'edit_file') && /^(created|edited) /.test(String(r.output))) wrote = true;
              log({ type: 'worker', id: input.id, line: `  → ${r.toolName}: ${tail(r.output).replace(/\s+/g, ' ').slice(0, 160)}` });
            }
            for (const e of toolErrors(step)) log({ type: 'worker', id: input.id, line: `  ✗ ${e}` });
            stepEvent(agent, worker, step as StepResult<ToolSet>);
            wake();
          },
        });
        let settled = false;
        const run = (async () => {
          const s = await agentLoop.stream({ prompt: input.goal + ctx.text, abortSignal: sig });
          let streamErr: unknown;
          for await (const part of s.fullStream) {
            if (part.type === 'text-delta') emit({ type: 'text.delta', agent, delta: part.text });
            else if (part.type === 'error') streamErr = part.error;
          }
          if (sig.aborted) throw sig.reason instanceof Error ? sig.reason : new Error('cancelled');
          if (streamErr) throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
          return await s.text;
        })().finally(() => { settled = true; wake(); });
        while (!settled) {
          await new Promise<void>((r) => (wake = r));
          onProgress({ ...p, log: [...p.log] });
        }
        return run;
      };
      let text: string;
      try {
        text = await runOnce(false);
      } catch (e) {
        if (sig.aborted || !isTransient(e)) throw e;
        const msg = (e as Error).message;
        log({ type: 'worker', id: input.id, line: `  ↻ transient provider error, retrying once on ${worker}: ${msg.slice(0, 200)}` });
        emit({ type: 'ratelimit', model: MODELS[worker], message: `transient, retrying: ${msg.slice(0, 200)}` });
        await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 20_000));
        kick();
        text = await runOnce(true);
      } finally {
        clearTimeout(timer);
      }
      const status: 'ok' | 'failed' = /STATUS:\s*ok/i.test(text) ? 'ok' : 'failed';
      // An empty final text (usually the step limit) used to surface as a blank `failed` and trigger a blind escalation.
      // Long reports are cut to their tail, which dropped the STATUS line: the TUI then showed ok tasks as "failed" and the
      // orchestrator lost the verdict (run 2026-11-22T18-03, relay-runner on Haiku). Always lead with the parsed status.
      const summary = text.trim()
        ? (text.length <= 1500 ? text : `STATUS: ${status} (report cut to its last 1500 chars)\n…${text.slice(-1500)}`)
        : `NO FINAL REPORT: the worker stopped after ${p.log.length} tool calls without a summary (likely the step limit). ` +
          `Inspect the workspace before retrying. Last actions:\n${p.log.slice(-6).join('\n')}`;
      ledger.set(input.id, { worker, status, summary });
      if (status === 'ok') keys.forEach((k) => seen.delete(k)); // later, different work on the same files starts fresh
      log({ type: 'result', id: input.id, status, summary, tokens });
      emit({ type: 'task.result', taskId: input.id, worker, status, summary });
      emit({ type: 'agent.status', agent, status: status === 'ok' ? 'done' : 'error' });
      return `[${worker}: ${r.reason}] attempt ${attempt}\n${summary}`;
    } catch (e) {
      const msg = (e as Error).message;
      const stuck = msg.startsWith('watchdog:');
      const cancelled = !stuck && (mine.signal.aborted || signal?.aborted);
      const status = stuck ? 'stuck' : cancelled ? 'cancelled' : 'failed';
      log({ type: 'result', id: input.id, status, summary: msg });
      emit({ type: 'task.result', taskId: input.id, worker, status, summary: msg });
      emit({ type: 'agent.status', agent, status: cancelled ? 'cancelled' : 'error', detail: msg.slice(0, 200) });
      return `${stuck ? 'STUCK' : cancelled ? 'CANCELLED by the human' : 'ERROR'}: ${msg}`;
    } finally {
      release();
      running.delete(input.id);
      leases.release(input.id);
    }
  }

  const dispatch = tool({
    description:
      'Delegate one coding task. The router picks Beam (long-horizon/large context) or Flint (fast, scoped); a third attempt goes to a paid model. Set visual=true for web/UI work the worker must look at (vision models: Qwen scoped, DeepSeek large). ' +
      'Declare every file the worker must write; tasks with overlapping files are rejected until the other finishes.',
    inputSchema: z.object({
      id: z.string(),
      kind: z.enum(['explore', 'architecture', 'refactor', 'terminal', 'bugfix', 'test', 'boilerplate', 'feature']),
      goal: z.string(),
      files: z.array(z.string()).default([]),
      estTokens: z.number().int().nonnegative(),
      prefer: z.enum(FREE_WORKERS).optional(),
      context: z.array(z.string()).default([]).describe('Spec/reference files the worker needs (e.g. the task brief, shared types). They are read once and put in the worker prompt, so workers do not spend steps re-reading them.'),
      visual: z.boolean().optional().describe('true when the worker must LOOK at something: web/UI work, screenshots, design mockups, images, diagrams (architecture/flow/sequence). Routes to a vision model that can screenshot pages and view images.'),
    }),
    // Generator: each yield updates the TUI tool card; toModelOutput sends only the summary to the orchestrator.
    execute: async function* (input, { abortSignal }): AsyncGenerator<Progress> {
      const finish = (p: Progress, summary: string) => ({ ...p, done: true, summary });
      if (mode === 'plan') return yield finish({ log: [], done: false }, 'REFUSED: plan mode. Do not dispatch; present your plan (tasks, files, order, risks) and stop.');
      if (halted) return yield finish({ log: [], done: false }, 'REFUSED: the batch plan is halted (verify failed twice). Report to the user.');
      if (++dispatches > MAX_DISPATCHES) {
        return yield finish({ log: [], done: false }, plan
          ? 'REFUSED: dispatch budget for this batch exhausted. Call batch_done.'
          : 'REFUSED: dispatch budget exhausted. Report to the user; for big requests call plan first to split the work into batches.');
      }
      // Bridge runWorker's callback progress into this generator's yields.
      const queue: Progress[] = [];
      let last: Progress = { log: [], done: false };
      let wake = () => {};
      let result: string | undefined;
      const job = runWorker(input, abortSignal, (p) => { queue.push(p); wake(); }).then((s) => { result = s; wake(); });
      while (result === undefined || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        while (queue.length) yield (last = queue.shift()!);
      }
      await job;
      yield finish(last, result);
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: output?.summary ?? 'still running' }),
  });

  const status = tool({
    description: 'Show the shared task ledger (what each worker reported).',
    inputSchema: z.object({}),
    execute: async () => Object.fromEntries(ledger),
  });

  const ask_user = tool({
    description: 'Ask the human a question and wait for the answer. Use it for real ambiguity or when workers conflict; not for routine progress.',
    inputSchema: z.object({ question: z.string() }),
    execute: async ({ question }, { abortSignal }) => {
      const id = randomUUID().slice(0, 8);
      log({ type: 'ask', id, question, state: 'request' });
      emit({ type: 'human.input', question });
      try { return await opts.askUser!(question, abortSignal); } finally { log({ type: 'ask', id, question, state: 'answered' }); }
    },
  });

  const plan_tool = tool({
    description:
      `Split a request that needs more than ~10 dispatches into batches, BEFORE dispatching anything. Up to ${MAX_BATCHES} batches of up to 10 tasks, ` +
      'in dependency order. verify: a command that must pass before the next batch starts (e.g. "npm test"). Each batch gets a fresh dispatch budget.',
    inputSchema: z.object({
      batches: z.array(z.object({ id: z.string(), goal: z.string(), tasks: z.array(z.union([z.string(), z.object({ id: z.string().optional(), goal: z.string().optional() }).passthrough()])).min(1).max(10) })).min(1).max(MAX_BATCHES),
      verify: z.string().optional(),
    }),
    execute: async (input) => {
      if (plan && batchIdx < plan.batches.length && !halted) return `REFUSED: a plan is in progress (batch ${batchIdx + 1}/${plan.batches.length}). Finish it.`;
      // Ampersand sometimes sends tasks as {id, goal} objects (run 2026-11-22T18-03: first plan call failed validation).
      const name = (t: string | { id?: string; goal?: string }) => (typeof t === 'string' ? t : [t.id, t.goal].filter(Boolean).join(': ') || JSON.stringify(t));
      plan = { ...input, batches: input.batches.map((b) => ({ ...b, tasks: b.tasks.map(name) })) };
      batchIdx = verifyFails = dispatches = 0;
      halted = false;
      batchLog.length = 0;
      log({ type: 'plan', batches: plan.batches, verify: plan.verify });
      batchEvent('start');
      return `Plan saved. Batch 1/${plan.batches.length} (${plan.batches[0].id}): ${plan.batches[0].goal}\nTasks: ${plan.batches[0].tasks.join('; ')}\nCall batch_done when its tasks are done.`;
    },
  });
  const batch_done = tool({
    description: 'Close the current batch after its tasks are done: runs the plan\'s verify command, then opens the next batch with a fresh dispatch budget.',
    inputSchema: z.object({ summary: z.string().describe('what this batch delivered: files, tests, open risks (under 120 words)') }),
    execute: async ({ summary }, { abortSignal }) => {
      if (!plan || batchIdx >= plan.batches.length) return 'No open batch. Finish with your report.';
      if (halted) return 'The plan is halted. Report to the user.';
      const b = plan.batches[batchIdx];
      if (plan.verify) {
        const out = await runCommand('orch', plan.verify, abortSignal);
        if (!out.startsWith('exit=0')) {
          if (++verifyFails >= 2) {
            halted = true;
            batchEvent('failed', out.slice(-400));
            return `STOP: verify failed twice for batch ${b.id}. Do not dispatch more; report to the user.\n${out}`;
          }
          return `VERIFY FAILED for batch ${b.id}; the batch stays open (${Math.max(0, MAX_DISPATCHES - dispatches)} dispatches left). Fix it, then call batch_done again.\n${out}`;
        }
      }
      verifyFails = 0;
      batchLog.push(`- ${b.id} [done]: ${summary.slice(0, 600)}`);
      batchEvent('done', summary);
      if (++batchIdx >= plan.batches.length) return 'All batches done. Finish with your final report.';
      dispatches = 0;
      compactPending = true;
      batchEvent('start');
      const nb = plan.batches[batchIdx];
      return `Batch ${b.id} closed. Batch ${batchIdx + 1}/${plan.batches.length} (${nb.id}): ${nb.goal}\nTasks: ${nb.tasks.join('; ')}`;
    },
  });
  // Replaces the finished batches' turns with a short handoff, so later batches start with a small context.
  const handoff = (request: string) => {
    const nb = plan!.batches[batchIdx];
    const done = `${request}\n\n[BATCH HANDOFF] Batches done so far:\n${batchLog.join('\n')}\n\n`;
    if (!nb) return `${done}All batches are done. Finish with your final report.`;
    return done +
      `Current batch ${batchIdx + 1}/${plan!.batches.length} (${nb.id}): ${nb.goal}\nTasks: ${nb.tasks.join('; ')}\n` +
      `Remaining after it: ${plan!.batches.slice(batchIdx + 1).map((x) => x.id).join(', ') || '(none)'}. Dispatch this batch's tasks, then call batch_done.`;
  };
  const msgText = (m: ModelMessage) => (typeof m.content === 'string' ? m.content : m.content.map((c) => ('text' in c ? c.text : '')).join(''));

  const { list_files, read_file } = fsTools('orchestrator', 'orch'); // read-only: no lease, so write_file is omitted
  const agent = new ToolLoopAgent({
    model: model('orch'),
    instructions: `You coordinate two coding workers and the user. Workspace: ${ROOT}
- Read specs/small files yourself with read_file/list_files; dispatch only real work, never "read this file for me".
- Break the request into tasks; dispatch them via the dispatch tool. Prefer one exploration task before edits on unfamiliar code.
- Track the shared goal. If two worker reports contradict each other, do not pick silently: dispatch a Beam "architecture" task to reconcile, or ask the user.
- A failed task may be retried once with the SAME goal text (the router escalates it). Never retry more than that.
- Workers can run tests in a sandbox; ask for that in goals that change code.
- If the request needs more than ~10 dispatches, call plan FIRST to split it into batches; work one batch at a time and call batch_done after each. Never try to fit a big request into one batch.
- Put the spec/brief and shared type files each task needs in dispatch \`context\`; workers then start writing instead of re-reading.
- Dispatch all independent tasks of a batch in the SAME step (parallel tool calls); one dispatch per step wastes minutes.
- Messages from workers, the human or the system arrive as [MESSAGES]; answer a running worker with send_message (to: "task:<id>").
- Pass when there is nothing useful to add. Finish with a short report: done, not done, risks.${
      opts.resumeContext ? `\n\nYou are RESUMING an earlier run. Restored state from its journal:\n${opts.resumeContext}` : ''}`,
    tools: { dispatch, status, plan: plan_tool, batch_done, list_files, read_file, send_message: sendTool('orch'), ...(opts.askUser ? { ask_user } : {}) },
    stopWhen: ({ steps }) => steps.length >= ORCH_STEPS_PER_BATCH * (1 + batchIdx - turnBatchBase),
    // Ampersand returns encrypted reasoning; once the TUI rebuilds history from UI messages the gateway
    // rejects it ("Encrypted reasoning is invalid or incompatible", 400). Prior reasoning isn't needed, so drop it.
    prepareStep: async ({ messages, stepNumber }) => {
      const last = messages.at(-1);
      if (stepNumber === 0) {
        turnBatchBase = Math.min(batchIdx, plan?.batches.length ?? 0);
        if (last?.role === 'user') log({ type: 'user', text: msgText(last) });
      }
      // Compact ONCE when a batch closes: prepareStep overrides persist into later steps (ai 7), so the old per-step re-slice at a
      // fixed index dropped every new step and the orchestrator in batch 2+ saw only the handoff (it looped on status/read_file).
      if (compactPending && plan) {
        compactPending = false;
        const request = [...messages].reverse().find((m) => m.role === 'user' && !/^(\[MESSAGES\]|Step budget used up)/.test(msgText(m)));
        const orig = request ? msgText(request).split('\n\n[BATCH HANDOFF]')[0] : '';
        messages = [{ role: 'user', content: handoff(orig) }];
      }
      messages = deliver('orch', messages);
      if (gate) await gate.checkpoint('orch');
      emit({ type: 'agent.status', agent: 'orch', status: 'thinking' });
      if (stepNumber >= ORCH_STEPS_PER_BATCH * (1 + batchIdx - turnBatchBase) - 1)
        return finalStep(stripReasoning(messages), 'what was done (with batch progress), what is NOT done, risks, and exactly what the user should say to continue.');
      return { messages: stripReasoning(messages) };
    },
    onStepEnd: (step) => {
      const errors = toolErrors(step);
      log({ type: 'step', text: step.text, tools: step.toolCalls.map((c) => c.toolName), usage: { in: step.usage.inputTokens ?? 0, out: step.usage.outputTokens ?? 0 }, ...(errors.length ? { errors } : {}) });
      stepEvent('orch', 'orch', step as StepResult<ToolSet>);
    },
  });

  // UI controls. Cancelling the orchestrator itself is the caller's job (abort the signal passed to stream()).
  const controls = {
    cancel(taskId: string) { running.get(taskId)?.abort(new Error('cancelled by user')); return running.has(taskId); },
    cancelAll() { for (const c of running.values()) c.abort(new Error('cancelled by user')); },
    running: () => [...running.keys()],
    // Message any agent ('orch', 'task:<id>'); delivered at its next step. A UI's "take over" note goes through here.
    send(to: Address, text: string, inReplyTo?: string) { return mailbox.send({ from: 'human', to, text, inReplyTo }); },
    setMode(m: Mode) { mode = m; log({ type: 'mode', mode: m }); emit({ type: 'mode', mode: m }); },
    mode: () => mode,
    redispatch(taskId: string, worker: Worker, signal?: AbortSignal) {
      const t = tasks.get(taskId);
      if (!t) throw new Error(`unknown task ${taskId}`);
      if (running.has(taskId)) throw new Error(`task ${taskId} is still running`);
      return runWorker(t, signal, () => {}, worker);
    },
  };
  return Object.assign(agent, { controls });
}

// Tool calls that failed (bad input, thrown errors): journaled so a rejected dispatch is visible (run 19-17: 6 of 14 rejected, unlogged).
function toolErrors(step: { content: readonly unknown[] }): string[] {
  return (step.content as { type: string; toolName?: string; error?: unknown }[])
    .filter((c) => c.type === 'tool-error')
    .map((c) => `${c.toolName}: ${(c.error instanceof Error ? c.error.message : String(c.error)).replace(/\s+/g, ' ').slice(0, 300)}`);
}

export function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && Array.isArray(m.content)
      ? { ...m, content: m.content.filter((p) => p.type !== 'reasoning') }
      : m,
  );
}

// Wrap each tool's execute to emit tool.start / tool.end. Plain (non-generator) tools only.
export function instrument<T extends ToolSet>(tools: T, agent: AgentId, emit: Emit): T {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const exec = t.execute as ((input: unknown, o: { toolCallId: string }) => Promise<unknown>) | undefined;
    if (!exec) { out[name] = t; continue; }
    out[name] = {
      ...t,
      execute: async (input: unknown, o: { toolCallId: string }) => {
        const callId = o?.toolCallId ?? randomUUID();
        emit({ type: 'tool.start', agent, callId, tool: name, input });
        emit({ type: 'agent.status', agent, status: 'tool', detail: name });
        try {
          const res = await exec(input, o);
          emit({ type: 'tool.end', agent, callId, ok: !/^(DENIED|FAILED)/.test(String(res)), outputTail: tail(res) });
          return res;
        } catch (e) {
          emit({ type: 'tool.end', agent, callId, ok: false, outputTail: (e as Error).message });
          throw e;
        }
      },
    } as unknown as ToolSet[string];
  }
  return out as T;
}

// Trust boundary: model-supplied paths must stay inside ROOT.
export const makeSafe = (ROOT: string) => (p: string) => {
  const abs = resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) throw new Error(`path escapes workspace: ${p}`);
  return abs;
};

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const IMAGE_MAX = 5 * 1024 * 1024;

// Vision workers only: Beam/Flint are text-only and would reject image content.
export function viewImageTool(ROOT: string) {
  const safe = makeSafe(ROOT);
  return tool({
    description: 'Look at an image file (png/jpg/webp/gif, max 5 MB) relative to the workspace root, e.g. a screenshot you just took.',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }): Promise<{ error: string } | { path: string; mediaType: string; data: string }> => {
      const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
      if (!type) return { error: `not an image type I can show: ${path}` };
      const buf = await readFile(safe(path));
      if (buf.length > IMAGE_MAX) return { error: `${path} is ${buf.length} bytes; max ${IMAGE_MAX}. Take a smaller screenshot.` };
      return { path, mediaType: type, data: buf.toString('base64') };
    },
    toModelOutput: ({ output }) => 'error' in output
      ? { type: 'text' as const, value: output.error }
      : { type: 'content' as const, value: [{ type: 'text' as const, text: `image ${output.path}` }, { type: 'file' as const, mediaType: output.mediaType, data: { type: 'data' as const, data: output.data } }] },
  });
}

type FsHooks = { emit?: Emit; gate?: Gate; agent?: AgentId; mode?: () => Mode; preRead?: Map<string, number> };

export function makeFsTools(ROOT: string, leases: Leases, taskId: string, h: FsHooks = {}) {
  const safe = makeSafe(ROOT);
  const emit = h.emit ?? (() => {});
  const agent: AgentId = h.agent ?? `task:${taskId}`;
  const lastRead = new Map<string, number>(h.preRead); // path -> mtimeMs, per task: repeat reads of unchanged files are elided
  const ask = () => !!h.gate && h.mode?.() === 'ask';
  const snap = (s: string) => (s.length <= SNAPSHOT_MAX ? s : undefined);
  return {
    list_files: tool({
      description: 'List entries in a directory relative to the workspace root.',
      inputSchema: z.object({ dir: z.string().default('.') }),
      execute: async ({ dir }) =>
        (await readdir(safe(dir), { withFileTypes: true }))
          .filter((e) => !['node_modules', '.git'].includes(e.name))
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name)),
    }),
    read_file: tool({
      description: 'Read a UTF-8 file relative to the workspace root.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const abs = safe(path);
        const mtime = (await stat(abs)).mtimeMs;
        if (lastRead.get(abs) === mtime) return `(unchanged since you last read ${path} in this task; use your earlier copy)`;
        lastRead.set(abs, mtime);
        emit({ type: 'file.read', agent, path: relative(ROOT, abs) });
        // The orchestrator reads specs only; a 4.7k-line debug log in its context preceded "request exceeded its processing deadline" (run 2026-11-22T18-03).
        const max = agent === 'orch' ? 40_000 : 200_000;
        const text = await readFile(abs, 'utf8');
        return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated: ${path} is ${text.length} chars, showing the first ${max}${agent === 'orch' ? '; dispatch a worker to dig into large files' : ''}]`;
      },
    }),
    // Whole-file writes only create files: a worker rewriting a 1.5k-line script truncated it (run 1, 2026-11-21).
    write_file: tool({
      description: 'Create a NEW file in your lease. Fails if the file exists — use edit_file for existing files.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }, o) => {
        const rel = relative(ROOT, safe(path));
        if (!leases.holds(taskId, rel)) return `DENIED: ${rel} is not in your lease; report it instead.`;
        if (ask()) {
          const d = await h.gate!.beforeTool(agent, 'write_file', { path: rel, content }, 'ask mode: create file', o?.abortSignal);
          if (!d.approve) return `DENIED by the human reviewer: do not create ${rel}; report it.`;
          content = (d.input as { content?: string } | undefined)?.content ?? content;
        }
        await mkdir(dirname(safe(path)), { recursive: true });
        try {
          await writeFile(safe(path), content, { flag: 'wx' });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') return `DENIED: ${rel} exists; use edit_file.`;
          throw e;
        }
        emit({ type: 'file.edit', agent, editId: randomUUID(), path: rel, op: 'create', beforeHash: null, afterHash: hash(content), after: snap(content) });
        return `created ${rel}`;
      },
    }),
    edit_file: tool({
      description:
        'Edit an existing file in your lease by replacing old_string with new_string. old_string must match exactly once ' +
        '(include surrounding lines to make it unique). Make several small edits rather than one huge one.',
      inputSchema: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string() }),
      execute: async ({ path, old_string, new_string }, o) => {
        const abs = safe(path);
        const rel = relative(ROOT, abs);
        if (!leases.holds(taskId, rel)) return `DENIED: ${rel} is not in your lease; report it instead.`;
        const text = await readFile(abs, 'utf8');
        const n = text.split(old_string).length - 1;
        if (n !== 1) return `FAILED: old_string matches ${n} times in ${rel}; it must match exactly once.`;
        let next = text.replace(old_string, () => new_string);
        // Destructive edit (drops more than half the file): ask the human first when a gate is present.
        if (h.gate && (next.length < text.length / 2 || ask())) {
          emit({ type: 'agent.status', agent, status: 'awaiting_approval', detail: `edit ${rel} (-${text.length - next.length} chars)` });
          const d = await h.gate.beforeTool(agent, 'edit_file', { path: rel, old_string, new_string }, next.length < text.length / 2 ? `removes ${Math.round((1 - next.length / text.length) * 100)}% of ${rel}` : `ask mode: edit ${rel}`, o?.abortSignal);
          emit({ type: 'agent.status', agent, status: 'tool', detail: 'edit_file' });
          if (!d.approve) return `DENIED by the human reviewer: edit of ${rel} rejected. Make a smaller edit or report.`;
          const ns = (d.input as { new_string?: string } | undefined)?.new_string;
          if (ns !== undefined) next = text.replace(old_string, () => ns);
        }
        await writeFile(abs, next);
        emit({ type: 'file.edit', agent, editId: randomUUID(), path: rel, op: 'edit', beforeHash: hash(text), afterHash: hash(next), before: snap(text), after: snap(next) });
        return `edited ${rel}`;
      },
    }),
  };
}
