// Central slash-command registry: feeds the `/` palette, `/help`, and execution.
// User commands: every $XDG_CONFIG_HOME/dot-swarm/commands/<name>.md becomes `/<name> [args]`,
// which sends the file's text (with $ARGUMENTS replaced) as the prompt.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type Mode = 'auto' | 'ask' | 'plan';
export const MODES: Mode[] = ['auto', 'ask', 'plan'];
export const MODE_HELP: Record<Mode, string> = {
  auto: 'workers act without asking',
  ask: 'approve shell commands and large deletions',
  plan: 'orchestrator reads and plans; no dispatch',
};

// What a command may do. The runner implements it (it owns the message history and the agent).
export interface CommandContext {
  note(text: string, tone?: 'info' | 'ok' | 'warn' | 'error'): void;
  clearScreen(): void;
  clearHistory(): void;
  compact(): string; // returns a status line
  toggleWorkers(): void;
  setMode(mode: Mode): void;
  getMode(): Mode;
  planNext(): void;
  status(): string;
  models(): string;
  runs(): string[];
  resume(runId: string): void; // ends this TUI session and restarts on that run
  send(prompt: string): void; // submit as a normal prompt
  commands(): Command[];
}

export interface Command {
  name: string; // without the slash
  description: string;
  source: 'swarm' | 'user';
  args?: string; // usage hint, e.g. "[run-id]"
  run(ctx: CommandContext, args: string): void;
}

const builtins: Command[] = [
  { name: 'help', description: 'List commands, modes and keys', source: 'swarm', run: (ctx) => ctx.note(helpText(ctx.commands())) },
  { name: 'plan', description: 'Plan mode for the next message only (no dispatch)', source: 'swarm', run: (ctx) => { ctx.planNext(); ctx.note('Next message runs in plan mode: the orchestrator reads and proposes, no dispatch.', 'info'); } },
  { name: 'workers', description: 'Toggle the live worker strip (also: w while running)', source: 'swarm', run: (ctx) => ctx.toggleWorkers() },
  { name: 'status', description: 'Show this run’s task ledger from the journal', source: 'swarm', run: (ctx) => ctx.note(ctx.status()) },
  {
    name: 'resume', description: 'Resume a past run (no arg: list recent runs)', source: 'swarm', args: '[run-id]',
    run: (ctx, args) => {
      const runs = ctx.runs();
      if (!args.trim()) { ctx.note(runs.length ? `Recent runs (newest last):\n${runs.slice(-8).map((r) => `  ${r}`).join('\n')}\n\nUse /resume <run-id or suffix>` : 'No runs yet.'); return; }
      const hit = [...runs].reverse().find((r) => r.startsWith(args.trim()) || r.endsWith(args.trim()));
      if (!hit) ctx.note(`No run matches "${args.trim()}".`, 'error');
      else ctx.resume(hit);
    },
  },
  { name: 'clear', description: 'Clear the screen and the conversation history', source: 'swarm', run: (ctx) => { ctx.clearHistory(); ctx.clearScreen(); } },
  { name: 'compact', description: 'Replace history with a journal summary to free context', source: 'swarm', run: (ctx) => ctx.note(ctx.compact(), 'ok') },
  { name: 'model', description: 'Show the models behind each agent', source: 'swarm', run: (ctx) => ctx.note(ctx.models()) },
  {
    name: 'mode', description: 'Show or set the mode: auto | ask | plan (also Shift+Tab)', source: 'swarm', args: '[auto|ask|plan]',
    run: (ctx, args) => {
      const m = args.trim() as Mode;
      if (MODES.includes(m)) ctx.setMode(m);
      else ctx.note(`Mode: ${ctx.getMode()} — ${MODE_HELP[ctx.getMode()]}. Options: ${MODES.join(', ')}`);
    },
  },
];

export function userCommands(dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dot-swarm', 'commands')): Command[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  return files.map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const first = text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '';
    return {
      name: f.slice(0, -3), description: first.slice(0, 80) || 'user command', source: 'user' as const, args: '[args]',
      run: (ctx: CommandContext, args: string) => ctx.send(text.replaceAll('$ARGUMENTS', args.trim())),
    };
  });
}

export function allCommands(): Command[] {
  const user = userCommands().filter((u) => !builtins.some((b) => b.name === u.name));
  return [...builtins, ...user];
}

// Prefix matches first, then subsequence (fuzzy) matches; stable within each group.
export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  if (!q) return cmds;
  const prefix = cmds.filter((c) => c.name.startsWith(q));
  const fuzzy = cmds.filter((c) => !c.name.startsWith(q) && isSubsequence(q, c.name));
  return [...prefix, ...fuzzy];
}

function isSubsequence(q: string, s: string) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

// "/name rest" -> [command, args] if it names a known command.
export function parseCommand(cmds: Command[], text: string): [Command, string] | undefined {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  const cmd = cmds.find((c) => c.name === m[1]);
  return cmd ? [cmd, m[2]] : undefined;
}

export function helpText(cmds: Command[]): string {
  const w = Math.max(...cmds.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))) + 2;
  return [
    'Commands:',
    ...cmds.map((c) => `  /${(c.name + (c.args ? ' ' + c.args : '')).padEnd(w)} ${c.description}${c.source === 'user' ? '  (user)' : ''}`),
    '',
    'Modes (Shift+Tab cycles): ' + MODES.map((m) => `${m} — ${MODE_HELP[m]}`).join(' · '),
    '',
    'Keys: Enter send · / commands · ↑/↓ scroll (or palette) · PgUp/PgDn page',
    '      [ / ] focus tool block · e / Space toggle it · E toggle all (while running)',
    '      Ctrl+↑/↓ focus · Ctrl+E toggle · Ctrl+O toggle all (while typing)',
    '      w workers · Esc cancel run / close palette · Ctrl+C twice quit · Ctrl+L redraw',
  ].join('\n');
}
