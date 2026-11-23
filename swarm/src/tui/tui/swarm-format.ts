// Swarm-specific presentation for the vendored TUI: agent identities, literal (non-Markdown) tool payloads,
// compact tool rows and dispatch cards. Every string coming from a model goes through sanitizeTerminalText
// before any TUI-owned ANSI is added.
import { sanitizeTerminalText } from './sanitize-terminal-text.ts';
import type { Worker } from '../../route.ts';

export const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m', inverse: '\x1b[7m', fg: '\x1b[39m',
  red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m', amber: '\x1b[38;5;214m', blue: '\x1b[94m',
  magenta: '\x1b[95m', cyan: '\x1b[96m', grey: '\x1b[90m', orange: '\x1b[38;5;209m', teal: '\x1b[38;5;43m',
};

export type AgentKey = 'user' | 'orch' | Worker;
export const AGENTS: Record<AgentKey, { name: string; role: string; model?: string; color: string }> = {
  user: { name: 'You', role: 'User', color: c.cyan },
  orch: { name: 'Ampersand', role: 'Orchestrator', model: 'ampersand-v0.1', color: c.magenta },
  beam: { name: 'Beam', role: 'Heavy Coder', model: 'beam-free', color: c.orange },
  flint: { name: 'Flint', role: 'Fast Coder', model: 'flint-v1.0', color: c.teal },
  deepseek: { name: 'DeepSeek', role: 'Paid Heavy Coder', model: 'deepseek-v4.1-flash-1017', color: c.blue },
  haiku: { name: 'Haiku', role: 'Paid Fast Coder', model: 'claude-haiku-5.5', color: c.amber },
};
export const badge = (k: AgentKey) => `${AGENTS[k].name} · ${AGENTS[k].role}`;

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
}

const MAX_PAYLOAD_LINES = 40;
const safe = (s: string) => sanitizeTerminalText(s, { multiline: true });

// Structured payload -> literal, highlighted lines. Multi-line strings become real line blocks, never "\n" escapes.
export function formatPayload(value: unknown, maxLines = MAX_PAYLOAD_LINES): string {
  const lines = payloadLines(value, 0);
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), `${c.dim}… ${lines.length - maxLines} more lines${c.reset}`].join('\n');
}

function scalar(v: unknown): string {
  if (typeof v === 'string') return `${c.green}${safe(v)}${c.fg}`;
  if (typeof v === 'number') return `${c.yellow}${v}${c.fg}`;
  if (typeof v === 'boolean' || v == null) return `${c.magenta}${String(v)}${c.fg}`;
  return safe(JSON.stringify(v));
}

function payloadLines(v: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth);
  if (typeof v === 'string') return safe(v).split('\n').map((l) => pad + l);
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${pad}${c.dim}[]${c.reset}`];
    if (v.every((x) => typeof x !== 'object' || x == null) && v.every((x) => !String(x).includes('\n'))) {
      const inline = v.map(scalar).join(`${c.dim}, ${c.reset}`);
      if (v.map(String).join(', ').length < 100) return [`${pad}${inline}`];
    }
    return v.flatMap((x) => {
      const inner = payloadLines(x, depth + 1);
      return [`${pad}${c.dim}-${c.reset} ${inner[0]?.trimStart() ?? ''}`, ...inner.slice(1)];
    });
  }
  if (typeof v === 'object' && v != null) {
    const out: string[] = [];
    for (const [k, x] of Object.entries(v)) {
      const key = `${pad}${c.blue}${safe(k)}${c.fg}${c.dim}:${c.reset}`;
      if (typeof x === 'string' && x.includes('\n')) {
        out.push(key, ...safe(x).split('\n').map((l) => `${pad}  ${c.dim}│${c.reset} ${l}`));
      } else if (typeof x === 'object' && x != null && !(Array.isArray(x) && payloadLines(x, 0).length === 1)) {
        out.push(key, ...payloadLines(x, depth + 1));
      } else {
        out.push(`${key} ${Array.isArray(x) ? payloadLines(x, 0)[0] : scalar(x)}`);
      }
    }
    return out.length ? out : [`${pad}${c.dim}{}${c.reset}`];
  }
  return [pad + scalar(v)];
}

// The one argument that identifies a routine call, for compact rows.
export function keyArg(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.path ?? i.dir ?? i.command ?? i.id ?? i.question ?? Object.values(i).find((x) => typeof x === 'string');
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ') : '';
  return safe(s.length > 80 ? s.slice(0, 77) + '…' : s);
}

export type ToolRowState = 'running' | 'ok' | 'error' | 'denied' | 'waiting';
const STATE_MARK: Record<ToolRowState, string> = {
  running: `${c.yellow}…${c.reset}`, ok: `${c.green}✓${c.reset}`, error: `${c.red}✗${c.reset}`,
  denied: `${c.red}⊘${c.reset}`, waiting: `${c.dim}·${c.reset}`,
};

export function compactRow(o: { tool: string; arg: string; ms?: number; state: ToolRowState; focused: boolean; expanded: boolean; spinner?: string }) {
  const caret = o.expanded ? '▾' : '▸';
  const dur = o.ms != null ? ` ${c.dim}(${formatDuration(o.ms)})${c.reset}` : '';
  const mark = o.state === 'running' && o.spinner ? `${c.yellow}${o.spinner}${c.reset}` : STATE_MARK[o.state];
  const head = `${o.focused ? c.inverse : ''}${c.dim}${caret}${c.reset}${o.focused ? c.inverse : ''} ${c.bold}${safe(o.tool)}${c.reset}`;
  return `${head}  ${c.grey}${o.arg}${c.reset}${dur}  ${mark}`;
}

export type DispatchInput = { id?: string; kind?: string; goal?: string; files?: string[]; estTokens?: number; prefer?: string };
export type DispatchProgress = { worker?: Worker; reason?: string; attempt?: number; log?: string[]; done?: boolean; summary?: string };

// Rich dispatch card. Returns header (1 line) and body lines.
export function dispatchCard(o: {
  input: DispatchInput; progress?: DispatchProgress; finished: boolean; expanded: boolean; focused: boolean;
  ms?: number; spinner?: string; live?: string;
}): { header: string; body: string[]; color: string } {
  const p = o.progress ?? {};
  const w = p.worker;
  const color = w ? AGENTS[w].color : c.grey;
  const kind = `${c.dim}[${c.reset}${c.bold}${safe(o.input.kind ?? '?')}${c.reset}${c.dim}]${c.reset}`;
  const who = w ? `${color}${AGENTS[w].name} · ${AGENTS[w].model}${c.reset}` : `${c.dim}routing…${c.reset}`;
  const result = /^\s*(REFUSED|CONFLICT|ERROR|STUCK|CANCELLED|NO FINAL REPORT)/.test(p.summary ?? '')
    ? 'error' : /STATUS:\s*ok/i.test(p.summary ?? '') ? 'ok' : p.summary ? 'error' : undefined;
  const state = !o.finished
    ? `${c.yellow}${o.spinner ?? '…'} ${o.live ?? 'working'}${c.reset}`
    : result === 'ok' ? `${c.green}✓ ok${c.reset}` : result === 'error' ? `${c.red}✗ failed${c.reset}` : `${c.green}✓ done${c.reset}`;
  const dur = o.ms != null ? ` ${c.dim}${formatDuration(o.ms)}${c.reset}` : '';
  const attempt = p.attempt && p.attempt > 1 ? ` ${c.amber}attempt ${p.attempt}${c.reset}` : '';
  const caret = o.expanded ? '▾' : '▸';
  const header = `${o.focused ? c.inverse : ''}${c.dim}${caret}${c.reset} ${c.bold}◆ dispatch${c.reset} ${kind} ${c.bold}${safe(o.input.id ?? '')}${c.reset} ${c.dim}→${c.reset} ${who}${attempt}  ${state}${dur}`;

  const body: string[] = [];
  const goal = safe(o.input.goal ?? '').split('\n');
  const goalLines = o.expanded ? goal : goal.slice(0, 3);
  body.push(...goalLines.map((l) => `${c.dim}│${c.reset} ${l}`));
  if (!o.expanded && goal.length > 3) body.push(`${c.dim}│ … ${goal.length - 3} more lines (e to expand)${c.reset}`);
  if (o.input.files?.length) body.push(`${c.dim}files:${c.reset} ${o.input.files.map((f) => c.grey + safe(f) + c.reset).join(', ')}`);
  if (p.reason) body.push(`${c.dim}route:${c.reset} ${safe(p.reason)}`);
  const log = p.log ?? [];
  const shown = o.expanded ? log : log.slice(-3);
  if (!o.expanded && log.length > 3) body.push(`${c.dim}  … ${log.length - 3} earlier steps${c.reset}`);
  body.push(...shown.map((l) => `${c.dim}  ↳${c.reset} ${logLine(l)}`));
  if (o.finished && p.summary) {
    const s = safe(p.summary.trim().replace(/^\[(beam|flint): [^\]]*\] attempt \d+\n/, '')).split('\n');
    const sl = o.expanded ? s : s.slice(0, 4);
    body.push(`${c.dim}result:${c.reset}`, ...sl.map((l) => `  ${l}`));
    if (!o.expanded && s.length > 4) body.push(`${c.dim}  … ${s.length - 4} more lines${c.reset}`);
  }
  return { header, body, color };
}

// Engine log lines look like `edit_file {"path":"a.py",...}` (JSON, possibly cut at 100 chars). Show `edit_file  a.py`.
export function logLine(line: string): string {
  const m = /^(\S+) ([\s\S]*)$/.exec(line);
  if (!m) return `${c.grey}${safe(line)}${c.reset}`;
  const [, tool, rest] = m;
  let arg = '';
  try {
    arg = keyArg(tool, JSON.parse(rest));
  } catch {
    const f = /"(path|dir|command|id|question)":"((?:[^"\\]|\\.)*)/.exec(rest);
    if (f) {
      try { arg = keyArg(tool, { [f[1]]: JSON.parse(`"${f[2]}"`) }); } catch { arg = keyArg(tool, { [f[1]]: f[2] }); }
    }
  }
  return `${c.bold}${safe(tool)}${c.reset}  ${c.grey}${arg}${c.reset}`;
}

// ---------- Inline (Claude Code style) lines ----------

// Claude-style spinner: a star that breathes.
export const STAR = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳'];

const TOOL_LABEL: Record<string, string> = {
  read_file: 'Read', list_files: 'List', write_file: 'Write', edit_file: 'Update', run_command: 'Bash',
  status: 'Status', ask_user: 'Ask', dispatch: 'Dispatch',
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name;
export const isExploreTool = (name: string) => name === 'read_file' || name === 'list_files' || name === 'status';

// `Read(app.py)`
export function toolTitle(name: string, input: unknown): string {
  const arg = keyArg(name, input);
  return `${c.bold}${toolLabel(name)}${c.reset}${arg ? `(${arg})` : ''}`;
}

// One dim line saying what came back.
export function toolSummary(name: string, output: unknown, errorText?: string): string {
  if (errorText) return safe(errorText.split('\n')[0]).slice(0, 160);
  const s = typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output);
  if (/^(DENIED|FAILED|ERROR|REFUSED|CONFLICT)/.test(s)) return safe(s.split('\n')[0]).slice(0, 160);
  if (name === 'read_file') {
    if (s.startsWith('(unchanged since')) return 'unchanged since last read';
    const n = s ? s.split('\n').length : 0;
    return `Read ${n} line${n === 1 ? '' : 's'}`;
  }
  if (name === 'list_files' && Array.isArray(output)) return `${output.length} entr${output.length === 1 ? 'y' : 'ies'}`;
  if (name === 'run_command') {
    const [head, ...rest] = s.split('\n');
    const code = /exit=(\S+)/.exec(head)?.[1] ?? '?';
    const first = rest.find((l) => l.trim())?.trim() ?? '';
    return `exit ${code}${first ? `  ${safe(first).slice(0, 120)}` : ''}`;
  }
  if (name === 'status' && output && typeof output === 'object') return `${Object.keys(output).length} task(s) in the ledger`;
  return safe(s.split('\n')[0] ?? '').slice(0, 160);
}

// "Read 2 files, listed 1 directory" for a run of exploration calls.
export function exploreSummary(tools: { name: string; input: unknown }[]): { title: string; detail: string } {
  const reads = tools.filter((t) => t.name === 'read_file');
  const lists = tools.filter((t) => t.name === 'list_files');
  const other = tools.length - reads.length - lists.length;
  const parts = [
    reads.length ? `read ${reads.length} file${reads.length === 1 ? '' : 's'}` : '',
    lists.length ? `listed ${lists.length} director${lists.length === 1 ? 'y' : 'ies'}` : '',
    other ? `${other} other` : '',
  ].filter(Boolean);
  const title = parts.join(', ');
  const names = [...new Set(tools.map((t) => keyArg(t.name, t.input)).filter(Boolean))];
  return { title: title.charAt(0).toUpperCase() + title.slice(1), detail: names.slice(0, 6).join(', ') + (names.length > 6 ? `, +${names.length - 6}` : '') };
}

// Result text without the orchestrator-facing prefix and the STATUS line.
export function cleanSummary(summary: string): string[] {
  return safe(summary.trim())
    .replace(/^\[(beam|flint): [^\]]*\] attempt \d+\n/, '')
    .split('\n')
    .filter((l) => l.trim() && !/^\**STATUS:\s*(ok|failed)\**\s*$/i.test(l.trim()));
}
