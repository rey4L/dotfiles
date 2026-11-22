// Glue between the swarm engine and the TUI: event bus, modes (auto/ask/plan), ask-mode approvals via the
// engine's Gate, plan mode, slash-command data sources. Used by cli.ts and the offline dev harness.
import { readdirSync } from 'node:fs';
import type { SwarmEvent } from '../events.ts';
import type { Gate } from '../events.ts';
import { JOURNAL_DIR, readJournal, summarize } from '../journal.ts';
import { MODELS } from '../route.ts';
import { ORCHESTRATOR_MODEL } from '../swarm.ts';
import { allCommands, type Mode } from './tui/commands.ts';
import type { SwarmTUIHost } from './run-agent-tui.ts';

const PLAN_PREFIX =
  '[PLAN MODE: read files and propose a concrete plan for the user to approve. Do NOT call dispatch and do not change anything.]\n\n';

export function createHost(o: { runId?: string; titleLabel?: string; onResume?: (runId: string) => void }) {
  const listeners = new Set<(e: SwarmEvent) => void>();
  const emit = (e: SwarmEvent) => listeners.forEach((f) => f(e));
  let mode: Mode = 'auto';
  let planOnce = false;
  let turnPlan = false; // plan mode in effect for the current turn (one-shot /plan included)
  let approve: ((text: string) => Promise<boolean>) | undefined;

  // ask mode: the engine calls beforeTool for shell commands and large deletions; other modes auto-approve.
  const gate: Gate = {
    async beforeTool(agent, tool, input, why) {
      if (mode !== 'ask' || !approve) return { approve: true };
      const i = input as { command?: string; path?: string };
      const who = agent === 'orch' ? 'Ampersand' : agent.replace(/^task:/, 'task ');
      return { approve: await approve(`${who} → ${tool} ${i.command ?? i.path ?? ''} (${why})`) };
    },
    async checkpoint() {},
  };

  const host: SwarmTUIHost = {
    events: { on: (f) => void listeners.add(f) },
    titleLabel: o.titleLabel,
    getMode: () => (planOnce ? 'plan' : mode),
    setMode: (m) => { mode = m; planOnce = false; },
    planNext: () => { planOnce = true; },
    wrapPrompt: (p) => {
      const plan = mode === 'plan' || planOnce;
      planOnce = false;
      turnPlan = plan;
      return plan ? PLAN_PREFIX + p : p;
    },
    commands: () => allCommands(),
    status: () => {
      if (!o.runId) return 'No journal for this session.';
      try { return summarize(readJournal(o.runId)).replace(/\n(The previous run (ended normally|stopped without finishing)[^\n]*)$/, ''); } catch { return 'Journal not readable yet.'; } // that last line is resume wording
    },
    models: () => [
      `Ampersand · Orchestrator  ${ORCHESTRATOR_MODEL}`,
      `Beam · Heavy Coder        ${MODELS.beam}`,
      `Flint · Fast Coder        ${MODELS.flint}`,
      '(all via Vercel AI Gateway; switching models is not supported from the TUI)',
    ].join('\n'),
    runs: () => {
      try { return readdirSync(JOURNAL_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort(); } catch { return []; }
    },
    compactSummary: () => host.status(),
    resume: (id) => o.onResume?.(id),
    approvals: { set: (h) => { approve = h; } },
  };

  // Plan mode enforcement: the dispatch tool refuses while plan mode is active.
  // shortcut: wraps the agent's tool object in place (relies on ToolLoopAgent.tools returning the live settings object); move into swarm.ts if the engine grows a mode hook.
  function enforcePlanMode(agent: { tools: Record<string, { execute?: unknown }> }) {
    const d = agent.tools.dispatch as { execute?: (...a: unknown[]) => AsyncGenerator<unknown> } | undefined;
    if (!d?.execute) return;
    const original = d.execute;
    d.execute = async function* (...args: unknown[]) {
      if (turnPlan || mode === 'plan') {
        yield { log: [], done: true, summary: 'REFUSED: plan mode is on. Present the plan to the user instead of dispatching.' };
        return;
      }
      yield* original.apply(this, args);
    };
  }

  return { host, emit, gate, enforcePlanMode };
}
