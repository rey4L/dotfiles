// Orchestrator (Ampersand) -> workers (Beam / Flint) over Vercel AI Gateway.
// Auth: AI_GATEWAY_API_KEY (env or swarm/.env), or OIDC via `vercel env pull`.
import { ToolLoopAgent, tool, isStepCount, gateway, wrapLanguageModel, type ModelMessage, type LanguageModel, type StepResult, type ToolSet } from 'ai';
import { z } from 'zod';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { route, Leases, MODELS, type Task, type Worker } from './route.ts';
import { runSandboxed } from './sandbox.ts';
import type { Journal } from './journal.ts';
import type { AgentId, Emit, Gate } from './events.ts';

export const ORCHESTRATOR_MODEL = 'humansand/ampersand-v0.1';
export const ORCHESTRATOR_CONTEXT = 1_000_000;
export const CONTEXT: Record<'orch' | Worker, number> = { orch: ORCHESTRATOR_CONTEXT, beam: 1_048_576, flint: 262_144 };
const MAX_DISPATCHES = 12;
const WATCHDOG_MS = 15 * 60_000; // a worker with no finished step for this long is aborted as stuck
const SNAPSHOT_MAX = 200_000; // edit snapshots above this size carry hashes only

const WORKER_INSTRUCTIONS: Record<Worker, string> = {
  beam: 'You are the long-horizon engineer. Explore broadly, reason about architecture, then make coherent multi-file changes.',
  flint: 'You are the fast, scoped engineer. Make the smallest correct change to the leased files. Do not explore beyond what the task needs.',
};

type Progress = { worker?: Worker; reason?: string; attempt?: number; log: string[]; done: boolean; summary?: string };
type DispatchInput = Omit<Task, 'attempt' | 'force'>;

export interface SwarmOptions {
  journal?: Journal;
  resumeContext?: string;
  emit?: Emit; // live UI events
  gate?: Gate; // approvals + pause
  askUser?: (question: string, signal?: AbortSignal) => Promise<string>; // enables the ask_user tool
  models?: Partial<Record<'orch' | Worker, LanguageModel>>; // test/mock injection
}

export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const tail = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(-400);

export function createSwarm(rootDir: string, opts: SwarmOptions = {}) {
  const log: Journal = opts.journal ?? (() => {});
  const emit: Emit = opts.emit ?? (() => {});
  const gate = opts.gate;
  const ROOT = resolve(rootDir);
  const leases = new Leases();
  const ledger = new Map<string, { worker: Worker; status: 'ok' | 'failed'; summary: string }>();
  const seen = new Map<string, number>(); // goal hash -> attempts (loop guard)
  const prevFiles = new Map<string, string[]>(); // goal hash -> files of the last attempt
  const tasks = new Map<string, DispatchInput>(); // for manual re-dispatch
  const running = new Map<string, AbortController>(); // taskId -> per-worker cancel
  let dispatches = 0;
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
  const fsTools = (taskId: string, agent: AgentId) => instrument(makeFsTools(ROOT, leases, taskId, { emit, gate, agent }), agent, emit);

  const runCommandTool = (agent: AgentId) => tool({
    description:
      'Run a shell command in the workspace inside a sandbox (no network, host read-only, only the workspace writable, 180s limit). ' +
      'Use it to run tests/linters. Returns exit code and the tail of the output.',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }, { abortSignal }) => {
      if (gate) {
        emit({ type: 'agent.status', agent, status: 'awaiting_approval', detail: command.slice(0, 120) });
        const d = await gate.beforeTool(agent, 'run_command', { command }, 'shell command', abortSignal);
        emit({ type: 'agent.status', agent, status: 'tool', detail: 'run_command' });
        if (!d.approve) return 'DENIED by the human reviewer. Do not retry this command; report it.';
        command = (d.input as { command?: string } | undefined)?.command ?? command;
      }
      return runSandboxed(ROOT, command, abortSignal);
    },
  });

  // One worker run. Shared by the dispatch tool and manual re-dispatch from a UI.
  async function runWorker(input: DispatchInput, signal: AbortSignal | undefined, onProgress: (p: Progress) => void, force?: Worker): Promise<string> {
    const p: Progress = { log: [], done: false };
    const key = createHash('sha256').update(input.kind + input.goal).digest('hex');
    const attempt = (seen.get(key) ?? 0) + 1;
    seen.set(key, attempt);
    // Escalations sometimes arrive with files=[] (run 3: Beam got no writable files); reuse the previous attempt's lease set.
    if (attempt > 1 && input.files.length === 0) input = { ...input, files: prevFiles.get(key) ?? [] };
    prevFiles.set(key, input.files);
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

      let wake = () => {};
      const agentLoop = new ToolLoopAgent({
        model: model(worker),
        instructions: `${WORKER_INSTRUCTIONS[worker]}
You may only write: ${files.join(', ') || '(nothing — read-only task)'}.
If you changed code and tests exist or you wrote them, run them with run_command and report the result; never claim tests pass without running them.
End with: STATUS: ok|failed, then a summary under 200 words (files changed, tests run + result, open risks).`,
        tools: { ...fsTools(input.id, agent), run_command: instrument({ run_command: runCommandTool(agent) }, agent, emit).run_command },
        stopWhen: isStepCount(worker === 'beam' ? 40 : 15), // loop guard inside each worker
        maxRetries: 3, // beam-free is per-model rate-limited on the free tier
        // no stripReasoning here: Beam rejects requests without its earlier reasoning_content (run 2, 2026-11-21)
        prepareStep: async () => {
          if (gate) await gate.checkpoint(agent, sig);
          emit({ type: 'agent.status', agent, status: 'thinking' });
          return {};
        },
        onStepEnd: (step) => {
          kick();
          for (const c of step.toolCalls) {
            const line = `${c.toolName} ${JSON.stringify(c.input).slice(0, 100)}`;
            p.log.push(line);
            log({ type: 'worker', id: input.id, line });
          }
          // Journal a short output tail per tool so `swarm tail` can explain odd behaviour (run 3: Beam looping on `echo hello`).
          for (const r of step.toolResults) {
            log({ type: 'worker', id: input.id, line: `  → ${r.toolName}: ${tail(r.output).replace(/\s+/g, ' ').slice(0, 160)}` });
          }
          stepEvent(agent, worker, step as StepResult<ToolSet>);
          wake();
        },
      });
      let settled = false;
      const run = (async () => {
        const s = await agentLoop.stream({ prompt: input.goal, abortSignal: sig });
        let streamErr: unknown;
        for await (const part of s.fullStream) {
          if (part.type === 'text-delta') emit({ type: 'text.delta', agent, delta: part.text });
          else if (part.type === 'error') streamErr = part.error;
        }
        if (sig.aborted) throw sig.reason instanceof Error ? sig.reason : new Error('cancelled');
        if (streamErr) throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
        return await s.text;
      })().finally(() => { settled = true; clearTimeout(timer); wake(); });
      while (!settled) {
        await new Promise<void>((r) => (wake = r));
        onProgress({ ...p, log: [...p.log] });
      }
      const text = await run;
      const status: 'ok' | 'failed' = /STATUS:\s*ok/i.test(text) ? 'ok' : 'failed';
      // An empty final text (usually the step limit) used to surface as a blank `failed` and trigger a blind escalation.
      const summary = text.trim()
        ? text.slice(-1500)
        : `NO FINAL REPORT: the worker stopped after ${p.log.length} tool calls without a summary (likely the step limit). ` +
          `Inspect the workspace before retrying. Last actions:\n${p.log.slice(-6).join('\n')}`;
      ledger.set(input.id, { worker, status, summary });
      log({ type: 'result', id: input.id, status, summary });
      emit({ type: 'task.result', taskId: input.id, worker, status, summary });
      emit({ type: 'agent.status', agent, status: status === 'ok' ? 'done' : 'error' });
      return `[${worker}: ${r.reason}] attempt ${attempt}\n${summary}`;
    } catch (e) {
      const msg = (e as Error).message;
      const stuck = msg.startsWith('watchdog:');
      const cancelled = !stuck && (mine.signal.aborted || signal?.aborted);
      const status = stuck ? 'stuck' : cancelled ? 'cancelled' : 'failed';
      log({ type: 'result', id: input.id, status: status === 'cancelled' ? 'failed' : status, summary: msg });
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
      'Delegate one coding task. The router picks Beam (long-horizon/large context) or Flint (fast, scoped). ' +
      'Declare every file the worker must write; tasks with overlapping files are rejected until the other finishes.',
    inputSchema: z.object({
      id: z.string(),
      kind: z.enum(['explore', 'architecture', 'refactor', 'terminal', 'bugfix', 'test', 'boilerplate', 'feature']),
      goal: z.string(),
      files: z.array(z.string()).default([]),
      estTokens: z.number().int().nonnegative(),
      prefer: z.enum(['beam', 'flint']).optional(),
    }),
    // Generator: each yield updates the TUI tool card; toModelOutput sends only the summary to the orchestrator.
    execute: async function* (input, { abortSignal }): AsyncGenerator<Progress> {
      const finish = (p: Progress, summary: string) => ({ ...p, done: true, summary });
      if (++dispatches > MAX_DISPATCHES) return yield finish({ log: [], done: false }, 'REFUSED: dispatch budget exhausted. Report to the user.');
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
      emit({ type: 'human.input', question });
      return opts.askUser!(question, abortSignal);
    },
  });

  const { list_files, read_file } = fsTools('orchestrator', 'orch'); // read-only: no lease, so write_file is omitted
  const agent = new ToolLoopAgent({
    model: model('orch'),
    instructions: `You coordinate two coding workers and the user. Workspace: ${ROOT}
- Read specs/small files yourself with read_file/list_files; dispatch only real work, never "read this file for me".
- Break the request into tasks; dispatch them via the dispatch tool. Prefer one exploration task before edits on unfamiliar code.
- Track the shared goal. If two worker reports contradict each other, do not pick silently: dispatch a Beam "architecture" task to reconcile, or ask the user.
- A failed task may be retried once with the SAME goal text (the router escalates it). Never retry more than that.
- Workers can run tests in a sandbox; ask for that in goals that change code.
- Pass when there is nothing useful to add. Finish with a short report: done, not done, risks.${
      opts.resumeContext ? `\n\nYou are RESUMING an earlier run. Restored state from its journal:\n${opts.resumeContext}` : ''}`,
    tools: { dispatch, status, list_files, read_file, ...(opts.askUser ? { ask_user } : {}) },
    stopWhen: isStepCount(25), // orchestrator turns are slow (p50 ~8s); keep the loop short
    // Ampersand returns encrypted reasoning; once the TUI rebuilds history from UI messages the gateway
    // rejects it ("Encrypted reasoning is invalid or incompatible", 400). Prior reasoning isn't needed, so drop it.
    prepareStep: async ({ messages, stepNumber }) => {
      const last = messages.at(-1);
      if (stepNumber === 0 && last?.role === 'user') {
        const text = typeof last.content === 'string' ? last.content : last.content.map((c) => ('text' in c ? c.text : '')).join('');
        log({ type: 'user', text });
      }
      if (gate) await gate.checkpoint('orch');
      emit({ type: 'agent.status', agent: 'orch', status: 'thinking' });
      return { messages: stripReasoning(messages) };
    },
    onStepEnd: (step) => {
      log({ type: 'step', text: step.text, tools: step.toolCalls.map((c) => c.toolName) });
      stepEvent('orch', 'orch', step as StepResult<ToolSet>);
    },
  });

  // UI controls. Cancelling the orchestrator itself is the caller's job (abort the signal passed to stream()).
  const controls = {
    cancel(taskId: string) { running.get(taskId)?.abort(new Error('cancelled by user')); return running.has(taskId); },
    cancelAll() { for (const c of running.values()) c.abort(new Error('cancelled by user')); },
    running: () => [...running.keys()],
    redispatch(taskId: string, worker: Worker, signal?: AbortSignal) {
      const t = tasks.get(taskId);
      if (!t) throw new Error(`unknown task ${taskId}`);
      if (running.has(taskId)) throw new Error(`task ${taskId} is still running`);
      return runWorker(t, signal, () => {}, worker);
    },
  };
  return Object.assign(agent, { controls });
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

type FsHooks = { emit?: Emit; gate?: Gate; agent?: AgentId };

export function makeFsTools(ROOT: string, leases: Leases, taskId: string, h: FsHooks = {}) {
  const safe = makeSafe(ROOT);
  const emit = h.emit ?? (() => {});
  const agent: AgentId = h.agent ?? `task:${taskId}`;
  const lastRead = new Map<string, number>(); // path -> mtimeMs, per task: repeat reads of unchanged files are elided
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
        return (await readFile(abs, 'utf8')).slice(0, 200_000);
      },
    }),
    // Whole-file writes only create files: a worker rewriting a 1.5k-line script truncated it (run 1, 2026-11-21).
    write_file: tool({
      description: 'Create a NEW file in your lease. Fails if the file exists — use edit_file for existing files.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const rel = relative(ROOT, safe(path));
        if (!leases.holds(taskId, rel)) return `DENIED: ${rel} is not in your lease; report it instead.`;
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
        if (h.gate && next.length < text.length / 2) {
          emit({ type: 'agent.status', agent, status: 'awaiting_approval', detail: `edit ${rel} (-${text.length - next.length} chars)` });
          const d = await h.gate.beforeTool(agent, 'edit_file', { path: rel, old_string, new_string }, `removes ${Math.round((1 - next.length / text.length) * 100)}% of ${rel}`, o?.abortSignal);
          emit({ type: 'agent.status', agent, status: 'tool', detail: 'edit_file' });
          if (!d.approve) return `DENIED by the human reviewer: this edit removes most of ${rel}. Make a smaller edit or report.`;
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
