// Vendored from @ai-sdk/tui (Apache-2.0, see ../LICENSE and ../NOTICE.md) and reworked for the swarm:
// accent-bar sections with agent badges, literal tool payloads, compact tool rows, dispatch cards,
// focus + expand/collapse, live worker strip, a run-state status bar, `/` command palette and modes.
import type {
  AgentTUIStreamResult,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
} from '../agent-tui-runner.ts';
import type {
  ResponseStatisticsMode,
  TerminalPartDisplayMode,
} from '../run-agent-tui.ts';
import { sliceVisible, visibleLength } from './layout.ts';
import { renderInlineMarkdown, renderMarkdown } from './markdown.ts';
import { sanitizeTerminalText } from './sanitize-terminal-text.ts';
import { TerminalFrameBuffer } from './terminal-frame-buffer.ts';
import {
  AGENTS, SPINNER, STAR, badge, c, cleanSummary, compactRow, dispatchCard, exploreSummary, formatDuration, formatPayload, formatTokens,
  isExploreTool, keyArg, logLine, toolSummary, toolTitle,
  type AgentKey, type DispatchInput, type DispatchProgress, type ToolRowState,
} from './swarm-format.ts';
import { filterCommands, MODE_HELP, type Command, type Mode } from './commands.ts';
import type { SwarmEvent } from '../../events.ts';
import type { Worker } from '../../route.ts';
import {
  getToolName,
  isToolUIPart,
  readUIMessageStream,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

export type TerminalInput = {
  isTTY?: boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): TerminalInput;
  off(event: 'data', listener: (chunk: Buffer) => void): TerminalInput;
  resume(): TerminalInput;
  pause(): TerminalInput;
  setRawMode?: (mode: boolean) => TerminalInput;
};

export type TerminalOutput = {
  columns?: number;
  rows?: number;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
  on(event: 'resize', listener: () => void): TerminalOutput;
  off(event: 'resize', listener: () => void): TerminalOutput;
};

// Swarm integration points. All optional: without them the renderer still works for a plain agent.
export type SwarmHooks = {
  events?: { on(listener: (e: SwarmEvent) => void): void };
  getMode?: () => Mode;
  cycleMode?: () => void;
  commands?: () => Command[];
  titleLabel?: string; // terminal/pane title suffix
};

export type TerminalRendererOptions = {
  input?: TerminalInput;
  output?: TerminalOutput;
  frameBuffer?: TerminalFrameBuffer;
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  responseStatistics?: ResponseStatisticsMode;
  contextSize?: number;
  swarm?: SwarmHooks;
};

export type TerminalSessionOptions = {
  title?: string;
  initialPrompt?: string;
  submittedPrompt?: string;
  waitForExit?: boolean;
  continueSession?: boolean;
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  responseStatistics?: ResponseStatisticsMode;
  contextSize?: number;
};

export type TerminalKey =
  | { type: 'character'; value: string }
  | { type: 'backspace' }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'ctrl-up' }
  | { type: 'ctrl-down' }
  | { type: 'page-up' }
  | { type: 'page-down' }
  | { type: 'ctrl-l' }
  | { type: 'ctrl-c' }
  | { type: 'ctrl-e' }
  | { type: 'ctrl-o' }
  | { type: 'ctrl-p' }
  | { type: 'ctrl-n' }
  | { type: 'escape' }
  | { type: 'ignore' };

type ChatSectionKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'note' | 'banner';
type Tone = 'info' | 'ok' | 'warn' | 'error';

type ToolInfo = {
  name: string;
  callId: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
  state: ToolRowState;
  finished: boolean;
};

type ChatSection = {
  kind: ChatSectionKind;
  title: string;
  rightTitle?: string;
  content: string;
  id?: string;
  agent?: AgentKey;
  tone?: Tone;
  tool?: ToolInfo;
  cache?: { key: string; lines: string[] };
};

type WorkerView = { taskId: string; worker: Worker; status: string; detail?: string; since: number; attempt: number; endedAt?: number };

const TICK_MS = 100;
const STALL_MS = 15_000;
const CTRL_C_WINDOW_MS = 2_000;
const PALETTE_ROWS = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const toneColor: Record<Tone, string> = { info: c.grey, ok: c.green, warn: c.amber, error: c.red };
const modeColor: Record<Mode, string> = { auto: c.green, ask: c.amber, plan: c.blue };

export class TerminalRenderer {
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;
  readonly #frameBuffer: TerminalFrameBuffer;
  readonly #reasoningMode: TerminalPartDisplayMode;
  readonly #defaultContextSize?: number;
  readonly #swarm: SwarmHooks;

  #sections: ChatSection[] = [];
  #inputText = '';
  #inputActive = false;
  #scrollOffset = 0;
  #title = '';
  #isInteractive = false;
  #interrupted = false;
  #contextSize?: number;
  #onData?: (chunk: Buffer) => void;
  #onResize?: () => void;
  #resolveStreamInterrupt?: () => void;
  #ticker?: ReturnType<typeof setInterval>;

  // run state
  #busy = false;
  #turnStart = 0;
  #lastEventAt = 0;
  #headline: { agent: AgentKey; label: string; since: number; attempt?: number } = { agent: 'orch', label: 'thinking', since: 0 };
  #outcome?: { tone: Tone; text: string };
  #turnDispatches = 0;
  #turnTokens = 0;
  #sessionTokens = 0;
  #uiTokens?: number;
  #orchContextPct?: number;
  #lastError?: string;
  #ctrlCArmedUntil = 0;
  #flash?: { text: string; until: number };

  // view state
  #toolTimes = new Map<string, { start: number; end?: number }>();
  #expanded = new Map<string, boolean>();
  #focusId?: string;
  #workers = new Map<string, WorkerView>();
  #workerStrip: 'auto' | 'on' | 'off' = 'auto';
  #paletteIndex = 0;
  #paletteDismissed = false;
  #approval?: { text: string; resolve: (ok: boolean) => void };

  // inline mode (default): finished sections are printed once into the terminal's own scrollback; only the live
  // region (unfinished sections + footer) is redrawn. Ctrl+O switches to the full-screen transcript (alt screen).
  #transcript = false;
  #committed = 0; // every section before this index is in scrollback
  #done = new Set<number>(); // sections at/after #committed already in scrollback (finished while an earlier one runs)
  #dynHeight = 0;
  #lastDyn = '';
  #history: string[] = [];
  #historyIndex = -1;

  constructor(options?: TerminalRendererOptions) {
    this.#input = options?.input ?? process.stdin;
    this.#output = options?.output ?? process.stdout;
    this.#frameBuffer = options?.frameBuffer ?? new TerminalFrameBuffer(this.#output);
    this.#reasoningMode = options?.reasoning ?? 'auto-collapsed';
    this.#defaultContextSize = options?.contextSize;
    this.#contextSize = options?.contextSize;
    this.#swarm = options?.swarm ?? {};
    this.#swarm.events?.on((e) => this.#onSwarmEvent(e));
  }

  // ---------- public API used by the runner and slash commands ----------

  note(text: string, tone: Tone = 'info') {
    this.#sections.push({ kind: 'note', title: '', content: text, tone });
    this.#paint();
  }

  clearScreen() {
    this.#sections = [];
    this.#scrollOffset = 0;
    this.#focusId = undefined;
    this.#expanded.clear();
    this.#outcome = undefined;
    this.#committed = 0;
    this.#done.clear();
    this.#dynHeight = 0;
    this.#lastDyn = '';
    if (!this.#transcript && this.#isInteractive) this.#output.write('\x1b[2J\x1b[3J\x1b[H');
    this.#repaint();
  }

  stop() {
    this.#stop();
  }

  toggleWorkers() {
    this.#workerStrip = this.#workerStripVisible() ? 'off' : 'on';
    this.#paint();
  }

  // Human-in-the-loop approval (ask mode). Resolves when the user presses y or n.
  requestApproval(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.#approval = { text, resolve };
      this.#setTitle('? swarm');
      this.#paint();
    });
  }

  async readPrompt(options?: TerminalSessionOptions): Promise<string> {
    this.#start(options);
    this.#inputActive = true;
    this.#inputText = options?.initialPrompt ?? '';
    this.#paletteIndex = 0;
    this.#paletteDismissed = false;
    this.#paint();

    return await new Promise((resolve, reject) => {
      const submit = (text: string) => {
        if (text.trim() && this.#history.at(-1) !== text) this.#history.push(text);
        this.#historyIndex = -1;
        this.#inputActive = false;
        this.#inputText = '';
        this.#paint();
        this.#detachInput();
        resolve(text);
      };
      this.#onData = (chunk) => {
        const key = parseKey(chunk);
        if (this.#transcript) return this.#handleTranscriptKey(key);
        const palette = this.#paletteItems();

        switch (key.type) {
          case 'character': {
            // A chunk like "text\r" (paste or fast typing) = text + Enter.
            const m = /^([^\r\n]*)[\r\n]+$/.exec(key.value);
            this.#inputText += m ? m[1] : key.value.replace(/[\r\n]+/g, ' ');
            if (!this.#inputText.startsWith('/')) this.#paletteDismissed = false;
            this.#paletteIndex = 0;
            if (m && this.#inputText.trim()) return submit(this.#inputText);
            this.#paint();
            break;
          }
          case 'backspace':
            this.#inputText = removeLastGrapheme(this.#inputText);
            if (!this.#inputText.startsWith('/')) this.#paletteDismissed = false;
            this.#paletteIndex = 0;
            this.#paint();
            break;
          case 'tab':
            if (palette) {
              const cmd = palette.items[this.#paletteIndex];
              if (cmd) this.#inputText = `/${cmd.name} `;
              this.#paint();
            }
            break;
          case 'enter': {
            if (palette) {
              const cmd = palette.items[this.#paletteIndex];
              if (cmd) return submit(`/${cmd.name}`);
            }
            if (this.#inputText.trim()) submit(this.#inputText);
            break;
          }
          case 'up':
          case 'ctrl-p':
            if (palette) this.#movePalette(-1, palette.items.length);
            else if (key.type === 'up') this.#historyStep(-1);
            break;
          case 'down':
          case 'ctrl-n':
            if (palette) this.#movePalette(1, palette.items.length);
            else if (key.type === 'down') this.#historyStep(1);
            break;
          case 'shift-tab':
            this.#swarm.cycleMode?.();
            this.#paint();
            break;
          case 'ctrl-o':
            this.#toggleTranscript();
            break;
          case 'ctrl-l':
            this.#repaint();
            break;
          case 'escape':
            if (palette) {
              this.#paletteDismissed = true;
              this.#paint();
            }
            break;
          case 'ctrl-c':
            if (this.#inputText) {
              this.#inputText = '';
              this.#paint();
            } else if (Date.now() < this.#ctrlCArmedUntil) {
              this.#stop();
              reject(interruptedError());
            } else {
              this.#ctrlCArmedUntil = Date.now() + CTRL_C_WINDOW_MS;
              this.#flash = { text: 'Press Ctrl+C again to exit', until: this.#ctrlCArmedUntil };
              this.#paint();
            }
            break;
          default:
            break;
        }
      };

      this.#attachInput();
    });
  }

  async renderStream(
    result: AgentTUIStreamResult,
    options?: TerminalSessionOptions,
  ): Promise<UIMessage | undefined> {
    this.#start(options);
    this.#inputActive = false;
    this.#addSubmittedPrompt(options?.submittedPrompt);
    this.#interrupted = false;
    this.#busy = true;
    this.#turnStart = Date.now();
    this.#lastEventAt = Date.now();
    this.#headline = { agent: 'orch', label: 'thinking', since: Date.now() };
    this.#outcome = undefined;
    this.#turnDispatches = 0;
    this.#turnTokens = 0;
    this.#uiTokens = undefined;
    this.#lastError = undefined;
    this.#setTitle('● swarm');
    this.#paint();
    const streamInterrupted = new Promise<void>((resolve) => {
      this.#resolveStreamInterrupt = resolve;
    });
    this.#onData = (chunk) => this.#handleStreamingKey(chunk);
    this.#attachInput();
    let responseMessage: UIMessage | undefined;
    const stream = toReadableStream(this.#observeUIMessageStream(result.uiMessageStream));

    try {
      const messages = readUIMessageStream({
        message: result.message,
        stream,
        onError: (error) => this.#addError(formatStreamError(error)),
      });

      for await (const message of takeUntil(messages, streamInterrupted)) {
        if (this.#interrupted) break;
        responseMessage = message;
        this.#renderAssistantMessage(message);
      }
    } finally {
      this.#resolveStreamInterrupt = undefined;
      if (this.#interrupted) result.abort?.();
      if (this.#approval) {
        this.#approval.resolve(false);
        this.#approval = undefined;
      }
      this.#detachInput();
      this.#busy = false;
      const elapsed = formatDuration(Date.now() - this.#turnStart);
      const tokens = this.#turnTokens || this.#uiTokens || 0;
      const stats = `${this.#turnDispatches} dispatch${this.#turnDispatches === 1 ? '' : 'es'}${tokens ? ` · ${formatTokens(tokens)} tokens` : ''}`;
      const err = this.#lastError as string | undefined; // set asynchronously by stream/swarm events
      this.#outcome = this.#interrupted
        ? { tone: 'error', text: `✗ Cancelled by user after ${elapsed}` }
        : err
          ? { tone: 'error', text: `✗ Failed after ${elapsed}: ${err.split('\n')[0].slice(0, 160)}` }
          : { tone: 'ok', text: `✓ Done in ${elapsed} · ${stats}` };
      this.note(this.#outcome.text, this.#outcome.tone);
      this.#setTitle(this.#interrupted || this.#lastError ? '✗ swarm' : '✓ swarm');
      this.#paint();
    }

    // Cancelled turns return nothing so the runner keeps the session instead of exiting.
    return this.#interrupted ? undefined : responseMessage;
  }

  async readToolApproval(
    request: AgentTUIToolApprovalRequest,
    options?: TerminalSessionOptions,
  ): Promise<AgentTUIToolApprovalResponse> {
    this.#start(options);
    this.#inputActive = false;
    const ok = await new Promise<boolean>((resolve) => {
      this.#approval = { text: `${request.title ?? request.toolName} ${keyArg(request.toolName, request.input)}`, resolve };
      this.#onData = (chunk) => this.#handleStreamingKey(chunk);
      this.#attachInput();
      this.#paint();
    });
    this.#detachInput();
    return ok ? { approved: true } : { approved: false, reason: 'Denied by user.' };
  }

  // ---------- lifecycle ----------

  #start(options?: TerminalSessionOptions) {
    this.#title = options?.title ?? this.#title;
    this.#contextSize = options?.contextSize ?? this.#defaultContextSize;
    if (this.#isInteractive) return;

    this.#isInteractive = true;
    this.#frameBuffer.reset();
    this.#output.write('\x1b[?25l');
    if (!this.#sections.some((s) => s.kind === 'banner')) this.#sections.unshift({ kind: 'banner', title: '', content: this.#title });
    if (this.#input.isTTY) {
      this.#input.setRawMode?.(true);
      this.#input.resume();
    }
    this.#onResize = () => this.#onTerminalResize();
    this.#output.on('resize', this.#onResize);
    this.#ticker = setInterval(() => this.#paint(), TICK_MS);
    this.#ticker.unref?.();
    this.#setTitle('✓ swarm');
  }

  #stop() {
    this.#detachInput();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = undefined;
    if (!this.#isInteractive) return;
    if (this.#input.isTTY) {
      this.#input.setRawMode?.(false);
      this.#input.pause();
    }
    if (this.#onResize) {
      this.#output.off('resize', this.#onResize);
      this.#onResize = undefined;
    }
    if (this.#transcript) {
      this.#output.write('\x1b[?1049l');
      this.#transcript = false;
    }
    // Leave the conversation in scrollback: commit everything, drop the live footer.
    this.#busy = false;
    this.#paintInline(true);
    this.#output.write('\x1b[?25h\x1b]2;\x07');
    this.#frameBuffer.reset();
    this.#isInteractive = false;
  }

  #setTitle(state: string) {
    const label = this.#swarm.titleLabel ? ` · ${this.#swarm.titleLabel}` : '';
    this.#output.write(`\x1b]2;${sanitizeTerminalText(state + label)}\x07`);
  }

  #attachInput() {
    if (this.#onData) this.#input.on('data', this.#onData);
  }

  #detachInput() {
    if (this.#onData) {
      this.#input.off('data', this.#onData);
      this.#onData = undefined;
    }
  }

  #handleStreamingKey(chunk: Buffer) {
    const key = parseKey(chunk);
    if (this.#transcript) return this.#handleTranscriptKey(key);

    if (this.#approval && key.type === 'character' && /^[yn]$/i.test(key.value)) {
      const { resolve, text } = this.#approval;
      this.#approval = undefined;
      const ok = key.value.toLowerCase() === 'y';
      this.note(`${ok ? '✓ approved' : '⊘ denied'}: ${text}`, ok ? 'ok' : 'warn');
      this.#setTitle('● swarm');
      resolve(ok);
      return;
    }

    switch (key.type) {
      case 'ctrl-o':
        this.#toggleTranscript();
        break;
      case 'shift-tab':
        this.#swarm.cycleMode?.();
        this.#paint();
        break;
      case 'character':
        if (key.value === 'w') this.toggleWorkers();
        break;
      case 'ctrl-l':
        this.#repaint();
        break;
      case 'escape':
      case 'ctrl-c':
        this.#interrupted = true;
        this.#resolveStreamInterrupt?.();
        if (this.#approval) {
          this.#approval.resolve(false);
          this.#approval = undefined;
        }
        break;
      default:
        break;
    }
  }

  // ---------- focus / expand ----------

  #focusable(): ChatSection[] {
    return this.#sections.filter((s) => s.id && (s.kind === 'tool' || s.kind === 'reasoning'));
  }

  #moveFocus(delta: number) {
    const list = this.#focusable();
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === this.#focusId);
    const next = i < 0 ? (delta < 0 ? list.length - 1 : 0) : Math.min(list.length - 1, Math.max(0, i + delta));
    this.#focusId = list[next].id;
    this.#scrollToSection(this.#focusId!);
    this.#paint();
  }

  #isExpanded(s: ChatSection): boolean {
    const o = s.id ? this.#expanded.get(s.id) : undefined;
    if (o != null) return o;
    if (s.kind === 'reasoning') return this.#reasoningMode === 'full';
    return s.tool?.state === 'error' && s.tool.name !== 'dispatch';
  }

  #toggleFocused() {
    const s = this.#sections.find((x) => x.id === this.#focusId) ?? this.#focusable().at(-1);
    if (!s?.id) return;
    this.#focusId = s.id;
    this.#expanded.set(s.id, !this.#isExpanded(s));
    this.#paint();
  }

  #toggleAll() {
    const list = this.#focusable();
    const expand = !list.every((s) => this.#isExpanded(s));
    for (const s of list) this.#expanded.set(s.id!, expand);
    this.#paint();
  }

  #scrollToSection(id: string) {
    const width = this.#bodyWidth();
    let line = 0;
    let target = -1;
    let len = 0;
    for (const s of this.#sections) {
      const n = this.#sectionLines(s, width).length;
      if (s.id === id) { target = line; len = n; break; }
      line += n;
    }
    if (target < 0) return;
    const total = this.#bodyLineCount();
    const h = this.#bodyContentHeight();
    const start = Math.max(0, total - h - this.#scrollOffset);
    if (target < start) this.#scrollOffset = this.#clampScrollOffset(total - h - target);
    else if (target + len > start + h) this.#scrollOffset = this.#clampScrollOffset(total - target - Math.min(len, h));
  }

  // ---------- palette ----------

  #paletteItems(): { items: Command[] } | undefined {
    if (!this.#inputActive || this.#paletteDismissed || !this.#swarm.commands) return undefined;
    const m = /^\/(\S*)$/.exec(this.#inputText);
    if (!m) return undefined;
    const items = filterCommands(this.#swarm.commands(), m[1]);
    return items.length ? { items } : undefined;
  }

  #movePalette(delta: number, n: number) {
    this.#paletteIndex = (this.#paletteIndex + delta + n) % n;
    this.#paint();
  }

  // ---------- sections ----------

  #addSubmittedPrompt(prompt: string | undefined) {
    if (prompt == null) return;
    const section = this.#sections.at(-1);
    if (section?.kind === 'user' && section.content === prompt) return;
    const before = this.#bodyLineCount();
    this.#sections.push({ kind: 'user', title: 'You', content: prompt, agent: 'user' });
    this.#paintAfterBodyChange(before);
  }

  #addError(content: string) {
    this.#lastError = content;
    const before = this.#bodyLineCount();
    this.#sections.push({ kind: 'error', title: 'Error', content });
    this.#paintAfterBodyChange(before);
  }

  #renderAssistantMessage(message: UIMessage) {
    const before = this.#bodyLineCount();
    const active = new Set<string>();

    for (const [index, part] of message.parts.entries()) {
      const id = sectionId(message.id, index);
      if (part.type === 'text') {
        const content = part.text.trim();
        if (!content) continue;
        active.add(id);
        this.#upsertSection({ id, kind: 'assistant', title: badge('orch'), agent: 'orch', content });
      } else if (part.type === 'reasoning') {
        const content = part.text.trim();
        if (this.#reasoningMode === 'hidden' || !content) continue;
        active.add(id);
        this.#upsertSection({ id, kind: 'reasoning', title: 'thinking', agent: 'orch', content });
      } else if (isToolUIPart(part)) {
        active.add(id);
        this.#upsertSection({ id, ...this.#toolSection(part) });
      }
    }

    this.#removeStaleAssistantSections(message.id, active);
    this.#paintAfterBodyChange(before);
  }

  #toolSection(part: ToolUIPart | DynamicToolUIPart): ChatSection {
    const name = getToolName(part);
    const callId = part.toolCallId;
    const t = this.#toolTimes.get(callId) ?? { start: Date.now() };
    this.#toolTimes.set(callId, t);
    const preliminary = 'preliminary' in part && part.preliminary === true;
    const finished = (part.state === 'output-available' && !preliminary) || part.state === 'output-error' || part.state === 'output-denied';
    if (finished && t.end == null) t.end = Date.now();
    const state: ToolRowState =
      part.state === 'output-error' ? 'error'
        : part.state === 'output-denied' ? 'denied'
          : part.state === 'input-streaming' || part.state === 'approval-requested' ? 'waiting'
            : finished ? (/^(DENIED|FAILED|ERROR)/.test(String((part as { output?: unknown }).output ?? '')) ? 'error' : 'ok')
              : 'running';
    return {
      kind: 'tool',
      title: name,
      content: '',
      tool: {
        name, callId, state, finished,
        input: 'input' in part ? part.input : undefined,
        output: 'output' in part ? part.output : undefined,
        errorText: part.state === 'output-error' ? part.errorText : undefined,
      },
    };
  }

  #upsertSection(section: ChatSection) {
    const existing = section.id ? this.#sections.find((s) => s.id === section.id) : undefined;
    if (existing) {
      Object.assign(existing, section, { cache: existing.cache });
      return;
    }
    this.#sections.push(section);
  }

  #removeStaleAssistantSections(messageId: string, active: Set<string>) {
    const prefix = `${messageId}:`;
    this.#sections = this.#sections.filter((s) => s.id == null || !s.id.startsWith(prefix) || active.has(s.id));
  }

  // ---------- stream + swarm events -> run state ----------

  async *#observeUIMessageStream(
    stream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>,
  ): AsyncIterable<UIMessageChunk> {
    for await (const chunk of iterateUIMessageStream(stream)) {
      this.#lastEventAt = Date.now();
      const orch = (label: string) => {
        if (this.#headline.agent !== 'orch' || this.#headline.label !== label) this.#headline = { agent: 'orch', label, since: Date.now() };
      };
      switch (chunk.type) {
        case 'start-step':
        case 'reasoning-delta':
          orch('thinking');
          break;
        case 'text-delta':
          orch('writing');
          break;
        case 'tool-input-available':
          orch(chunk.toolName === 'dispatch' ? `dispatching ${keyArg('dispatch', chunk.input)}` : `running ${chunk.toolName}`);
          break;
        case 'tool-output-available':
          if (!chunk.preliminary) orch('thinking');
          break;
        case 'error':
          this.#addError(chunk.errorText);
          break;
        case 'finish': {
          const usage = (chunk.messageMetadata as { usage?: { totalTokens?: number } } | undefined)?.usage;
          if (usage?.totalTokens != null) this.#uiTokens = usage.totalTokens;
          break;
        }
      }
      yield chunk;
    }
  }

  #onSwarmEvent(e: SwarmEvent) {
    this.#lastEventAt = Date.now();
    const now = Date.now();
    const taskOf = (agent: string) => (agent.startsWith('task:') ? agent.slice(5) : undefined);
    switch (e.type) {
      case 'dispatch':
        this.#turnDispatches++;
        this.#workers.set(e.taskId, { taskId: e.taskId, worker: e.worker, status: 'starting', since: now, attempt: e.attempt });
        this.#headline = { agent: e.worker, label: `starting ${e.taskId}`, since: now, attempt: e.attempt };
        break;
      case 'agent.status': {
        const id = taskOf(e.agent);
        const label =
          e.status === 'tool' ? `running ${e.detail ?? 'tool'}`
            : e.status === 'awaiting_approval' ? 'awaiting approval'
              : e.status === 'queued' ? 'queued (Beam slot)'
                : e.status;
        if (!id) {
          if (this.#busy && e.status !== 'done') this.#headline = { agent: 'orch', label, since: now };
          break;
        }
        const w = this.#workers.get(id);
        if (!w) break;
        if (w.status !== label) { w.status = label; w.since = now; }
        w.detail = e.detail;
        if (['done', 'error', 'cancelled'].includes(e.status)) w.endedAt = now;
        else this.#headline = { agent: w.worker, label: `${label} · ${id}`, since: w.since, attempt: w.attempt };
        break;
      }
      case 'step.end':
        this.#turnTokens += e.usage.in + e.usage.out;
        this.#sessionTokens += e.usage.in + e.usage.out;
        if (e.agent === 'orch') this.#orchContextPct = e.contextPct;
        break;
      case 'task.result': {
        const w = this.#workers.get(e.taskId);
        if (w) { w.status = e.status; w.endedAt = now; w.since = now; }
        if (this.#headline.agent !== 'orch') this.#headline = { agent: 'orch', label: 'thinking', since: now };
        break;
      }
      case 'ratelimit':
        this.#flash = { text: e.message.startsWith('transient') ? `${e.model}: provider hiccup; retrying once` : `rate limited on ${e.model}; retrying`, until: now + 8000 };
        break;
      case 'message': // mailbox traffic (full text is in `swarm tail`); system nudges are noise here
        if (e.from !== 'system') this.#flash = { text: `✉ ${e.from} → ${e.to}: ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`, until: now + 12000 };
        break;
      case 'error':
        if (e.agent === 'orch' || !e.agent) this.#lastError = e.message;
        break;
      default:
        break;
    }
  }

  // ---------- painting ----------

  #paintAfterBodyChange(previousBodyLineCount: number) {
    if (this.#transcript && this.#scrollOffset !== 0) {
      const delta = this.#bodyLineCount() - previousBodyLineCount;
      this.#scrollOffset = this.#clampScrollOffset(this.#scrollOffset + delta);
    }
    this.#paint();
  }

  #paint() {
    if (!this.#isInteractive) return;
    if (!this.#transcript) return this.#paintInline(false);
    const width = this.#width();
    const footer = this.#footerLines(width);
    const bodyHeight = Math.max(1, this.#height() - 1 - footer.length);
    const body = this.#visibleBodyLines(bodyHeight);
    while (body.length < bodyHeight) body.push('');
    const lines = [this.#headerLine(width), ...body, ...footer].map((l) => fit(l, width));
    this.#frameBuffer.present(lines.join('\n'));
  }

  // ---------- inline mode ----------

  #historyStep(delta: number) {
    if (!this.#history.length) return;
    const n = this.#history.length;
    const i = this.#historyIndex < 0 ? (delta < 0 ? n - 1 : -1) : this.#historyIndex + delta;
    if (i < 0 || i >= n) {
      this.#historyIndex = -1;
      this.#inputText = '';
    } else {
      this.#historyIndex = i;
      this.#inputText = this.#history[i];
    }
    this.#paint();
  }

  #toggleTranscript() {
    if (!this.#isInteractive) return;
    if (this.#transcript) {
      this.#transcript = false;
      this.#output.write('\x1b[?1049l\x1b[?25l');
      this.#lastDyn = ''; // force the live region to redraw where it was
      this.#paint();
    } else {
      this.#transcript = true;
      this.#scrollOffset = 0;
      this.#output.write('\x1b[?1049h\x1b[?25l');
      this.#frameBuffer.reset();
      this.#paint();
    }
  }

  // Full-screen transcript: scroll, focus and expand everything, then back.
  #handleTranscriptKey(key: TerminalKey) {
    switch (key.type) {
      case 'up': case 'down': this.#handleScroll(key.type); break;
      case 'page-up': case 'page-down': this.#handlePageScroll(key.type); break;
      case 'ctrl-up': this.#moveFocus(-1); break;
      case 'ctrl-down': this.#moveFocus(1); break;
      case 'enter': case 'ctrl-e': this.#toggleFocused(); break;
      case 'ctrl-l': this.#repaint(); break;
      case 'escape': case 'ctrl-o': this.#toggleTranscript(); break;
      case 'ctrl-c':
        this.#toggleTranscript();
        if (this.#busy) { this.#interrupted = true; this.#resolveStreamInterrupt?.(); }
        break;
      case 'character':
        if (key.value === 'q') this.#toggleTranscript();
        else if (key.value === '[' || key.value === 'k') this.#moveFocus(-1);
        else if (key.value === ']' || key.value === 'j') this.#moveFocus(1);
        else if (key.value === 'e' || key.value === ' ') this.#toggleFocused();
        else if (key.value === 'E') this.#toggleAll();
        break;
      default: break;
    }
  }

  #onTerminalResize() {
    if (this.#transcript) return this.#repaint();
    // Lines of the old live region may have re-wrapped; clear from the top of the visible screen part we own.
    this.#output.write(`\r\x1b[${Math.min(this.#dynHeight, this.#height()) > 1 ? Math.min(this.#dynHeight, this.#height()) - 1 : 0}A\x1b[J`.replace('\x1b[0A', ''));
    this.#dynHeight = 0;
    this.#lastDyn = '';
    this.#paint();
  }

  // A section is final once nothing about it can change: it is then printed into scrollback for good.
  #isFinal(i: number): boolean {
    const s = this.#sections[i];
    const next = this.#sections[i + 1];
    switch (s.kind) {
      case 'user': case 'note': case 'error': case 'banner': return true;
      case 'assistant': case 'reasoning': return !!next || !this.#busy;
      case 'tool': {
        if (!s.tool?.finished) return false;
        // A run of exploration calls commits together, as one "Read 3 files" line.
        if (isExploreTool(s.tool.name)) {
          if (!this.#busy) return true;
          if (!next) return false;
          // inside a run of exploration calls: the run is final when its last call is
          if (next.kind === 'tool' && next.tool && isExploreTool(next.tool.name)) return this.#isFinal(i + 1);
          return true;
        }
        return true;
      }
    }
  }

  #paintInline(final: boolean) {
    const width = this.#width();
    const inner = Math.max(20, width - 1);
    // 1. Commit every finished section, in completion order: a long-running dispatch must not hold everything after it
    // in the live region (it grew past the screen, was clipped and redrawn every tick: "vibrating", nothing to scroll).
    // The Ctrl+O transcript keeps the true order.
    const committed: string[] = [];
    const ready = (k: number) => !this.#done.has(k) && (final || this.#isFinal(k));
    for (let k = this.#committed; k < this.#sections.length; k++) {
      if (!ready(k)) continue;
      const s = this.#sections[k];
      if (s.kind === 'tool' && s.tool && isExploreTool(s.tool.name)) {
        let j = k;
        while (j < this.#sections.length && this.#sections[j].kind === 'tool' && this.#sections[j].tool && isExploreTool(this.#sections[j].tool!.name) && ready(j)) j++;
        committed.push(...this.#exploreLines(this.#sections.slice(k, j), inner));
        for (let m = k; m < j; m++) this.#done.add(m);
        k = j - 1;
        continue;
      }
      committed.push(...this.#inlineLines(s, inner, false));
      this.#done.add(k);
    }
    while (this.#done.has(this.#committed)) this.#done.delete(this.#committed++);

    // 2. The live region: unfinished sections, then the footer.
    let live: string[] = [];
    if (!final) {
      for (let k = this.#committed; k < this.#sections.length; k++) if (!this.#done.has(k)) live.push(...this.#inlineLines(this.#sections[k], inner, true));
      const footer = this.#inlineFooter(inner);
      const room = Math.max(3, this.#height() - footer.length - 1);
      if (live.length > room) live = [`${c.dim}  … ${live.length - room + 1} more lines above (ctrl+o for the transcript)${c.reset}`, ...live.slice(live.length - room + 1)];
      live.push(...footer);
    }
    const dyn = live.map((l) => clip(l, inner)).join('\n');
    if (!committed.length && dyn === this.#lastDyn) return;

    // 3. Rewind over the previous live region, print the commits, then the new live region.
    let out = '';
    if (this.#dynHeight > 0) out += `\r${this.#dynHeight > 1 ? `\x1b[${this.#dynHeight - 1}A` : ''}\x1b[J`;
    if (committed.length) out += committed.map((l) => clip(l, inner)).join('\n') + '\n';
    out += dyn;
    if (final && !dyn) out += '';
    this.#output.write(`\x1b[?2026h${out}\x1b[?2026l`);
    this.#dynHeight = final ? 0 : live.length;
    this.#lastDyn = dyn;
  }

  // Claude-Code-style lines for one section. `live` = still changing (spinners allowed).
  #inlineLines(s: ChatSection, inner: number, live: boolean): string[] {
    const wrapIndent = (text: string, first: string, rest: string) => {
      const out: string[] = [];
      const w = inner - visibleLength(rest);
      text.split('\n').forEach((line, n) => {
        const parts = wrapVisibleLine(line, Math.max(10, w));
        parts.forEach((p, m) => out.push((n === 0 && m === 0 ? first : rest) + p + c.reset));
      });
      return out;
    };
    switch (s.kind) {
      case 'banner': {
        const t = sanitizeTerminalText(s.content || 'swarm');
        const lines = [`${c.magenta}✻${c.reset} ${c.bold}swarm${c.reset}  ${c.dim}Ampersand → Beam / DeepSeek / MiniMax${c.reset}`, `  ${c.dim}${t}${c.reset}`, `  ${c.dim}/help for commands · shift+tab cycles modes · ctrl+o transcript${c.reset}`];
        const w = Math.min(inner - 2, Math.max(...lines.map(visibleLength)) + 2);
        return [`${c.dim}╭${'─'.repeat(w)}╮${c.reset}`, ...lines.map((l) => `${c.dim}│${c.reset} ${l}${' '.repeat(Math.max(0, w - 1 - visibleLength(l)))}${c.dim}│${c.reset}`), `${c.dim}╰${'─'.repeat(w)}╯${c.reset}`, ''];
      }
      case 'user':
        return ['', ...wrapIndent(sanitizeTerminalText(s.content, { multiline: true }), `${c.dim}>${c.reset} `, '  ').map((l) => `${c.grey}${l}`), ''];
      case 'assistant':
        return [...wrapIndent(renderMarkdown(s.content), `${c.reset}● `, '  '), ''];
      case 'reasoning': {
        const n = s.content.split('\n').length;
        return [`${c.dim}${c.italic}✻ Thinking… (${n} line${n === 1 ? '' : 's'}, ctrl+o to read)${c.reset}`, ''];
      }
      case 'note': {
        const col = toneColor[s.tone ?? 'info'];
        const glyph = s.tone === 'ok' ? '✻' : s.tone === 'error' ? '✗' : s.tone === 'warn' ? '⚠' : ' ';
        const text = sanitizeTerminalText(s.content, { multiline: true }).replace(/^[✓✗]\s*/, '');
        return [...wrapIndent(text, `${col}${glyph} `, '  ').map((l) => (s.tone === 'info' ? `${c.dim}${l}` : `${col}${l}`)), ''];
      }
      case 'error':
        return [...wrapIndent(sanitizeTerminalText(s.content, { multiline: true }), `${c.red}● Error:${c.reset} `, '  '), ''];
      case 'tool':
        return this.#toolInline(s, inner, live);
    }
  }

  #toolInline(s: ChatSection, inner: number, live: boolean): string[] {
    const t = s.tool!;
    const times = this.#toolTimes.get(t.callId);
    const ms = times ? (times.end ?? Date.now()) - times.start : undefined;
    const bullet = !t.finished ? `${c.yellow}${STAR[Math.floor(Date.now() / 120) % STAR.length]}${c.reset}`
      : t.state === 'error' || t.state === 'denied' ? `${c.red}●${c.reset}` : `${c.green}●${c.reset}`;
    const gutter = `  ${c.dim}⎿${c.reset}  `;
    const sub = (text: string) => `     ${c.dim}${text}${c.reset}`;

    if (t.name === 'dispatch') {
      const input = (t.input ?? {}) as { id?: string; kind?: string; goal?: string };
      const p = (t.output && typeof t.output === 'object' ? t.output : {}) as { worker?: Worker; reason?: string; attempt?: number; log?: string[]; summary?: string };
      const w = p.worker ? AGENTS[p.worker] : undefined;
      const who = w ? ` ${c.dim}→${c.reset} ${w.color}${w.name}${c.reset} ${c.dim}(${w.model})${c.reset}` : '';
      const attempt = p.attempt && p.attempt > 1 ? ` ${c.amber}attempt ${p.attempt}${c.reset}` : '';
      const out = [`${bullet} ${c.bold}Dispatch${c.reset}(${sanitizeTerminalText(input.id ?? '')}) ${c.dim}[${sanitizeTerminalText(input.kind ?? '?')}]${c.reset}${who}${attempt}`];
      const goal = sanitizeTerminalText((input.goal ?? '').split('\n')[0]);
      if (goal) out.push(`${gutter}${c.dim}${goal.slice(0, inner - 8)}${c.reset}`);
      if (!t.finished) {
        const wv = input.id ? this.#workers.get(input.id) : undefined;
        for (const l of (p.log ?? []).slice(-3)) out.push(`     ${c.dim}↳${c.reset} ${logLine(l)}`);
        if (wv && wv.endedAt == null) out.push(sub(`${wv.status} (${formatDuration(Date.now() - wv.since)})`));
      } else {
        const lines = cleanSummary(p.summary ?? '');
        const failed = /^(REFUSED|CONFLICT|ERROR|STUCK|CANCELLED|NO FINAL REPORT)/.test((p.summary ?? '').trim()) || !/STATUS:\s*ok/i.test(p.summary ?? '');
        const head = `${failed ? c.red + 'failed' : c.green + 'done'}${c.reset}${c.dim}${ms != null ? ` in ${formatDuration(ms)}` : ''}${(p.log?.length ?? 0) ? `, ${p.log!.length} step${p.log!.length === 1 ? '' : 's'}` : ''}${c.reset}`;
        out.push(sub(`${head}`).replace(c.dim, ''));
        for (const l of lines.slice(0, 3)) out.push(`     ${c.dim}${renderInlineMarkdown(l)}${c.reset}`);
        if (lines.length > 3) out.push(sub(`… +${lines.length - 3} lines (ctrl+o to expand)`));
      }
      out.push('');
      return out;
    }

    const head = `${bullet} ${toolTitle(t.name, t.input)}`;
    if (!t.finished) return [head, ...(live ? [] : [''])];
    const summary = toolSummary(t.name, t.output, t.errorText);
    const col = t.state === 'error' || t.state === 'denied' ? c.red : c.dim;
    return [head, `${gutter}${col}${summary}${c.reset}${ms != null && ms >= 1000 ? ` ${c.dim}(${formatDuration(ms)})${c.reset}` : ''}`, ''];
  }

  #exploreLines(group: ChatSection[], inner: number): string[] {
    if (group.length === 1) return [...this.#toolInline(group[0], inner, false)];
    const tools = group.map((g) => ({ name: g.tool!.name, input: g.tool!.input }));
    const { title, detail } = exploreSummary(tools);
    const bad = group.some((g) => g.tool!.state === 'error');
    return [`${bad ? c.red : c.green}●${c.reset} ${c.bold}${title}${c.reset}`, `  ${c.dim}⎿${c.reset}  ${c.dim}${detail.slice(0, inner - 8)}${c.reset}`, ''];
  }

  #modeLine(): string {
    const mode = this.#swarm.getMode?.() ?? 'auto';
    if (mode === 'auto') return `${c.green}⏵⏵ auto mode on${c.reset} ${c.dim}(shift+tab to cycle)${c.reset}`;
    if (mode === 'ask') return `${c.amber}⏸ ask mode on${c.reset} ${c.dim}· approve shell commands and big deletions (shift+tab to cycle)${c.reset}`;
    return `${c.teal}⏸ plan mode on${c.reset} ${c.dim}· read and plan, no dispatch (shift+tab to cycle)${c.reset}`;
  }

  #inlineFooter(inner: number): string[] {
    const now = Date.now();
    const out: string[] = [];
    if (this.#approval) {
      out.push(`${c.amber}╭─ Needs your approval${c.reset}`);
      for (const l of wrapVisibleLine(sanitizeTerminalText(this.#approval.text), Math.max(20, inner - 2))) out.push(`${c.amber}│${c.reset} ${l}`); // never cut what you approve
      out.push(`${c.amber}│${c.reset} ${c.bold}❯ y${c.reset} Yes   ${c.bold}n${c.reset} No`);
      out.push(`${c.amber}╰─${c.reset}`);
    }
    if (this.#busy) {
      const h = this.#headline;
      const a = AGENTS[h.agent];
      const stalled = now - this.#lastEventAt > STALL_MS;
      const star = STAR[Math.floor(now / 120) % STAR.length];
      const tail = `${formatDuration(now - this.#turnStart)}${this.#turnTokens ? ` · ↓ ${formatTokens(this.#turnTokens)} tokens` : ''} · esc to interrupt`;
      const wait = stalled ? ` ${c.amber}· waiting on API ${formatDuration(now - this.#lastEventAt)}${c.reset}` : '';
      out.push(`${stalled ? c.amber : c.orange}${star}${c.reset} ${a.color}${a.name}${c.reset} ${sanitizeTerminalText(h.label)}…${h.attempt && h.attempt > 1 ? ` ${c.amber}attempt ${h.attempt}${c.reset}` : ''} ${c.dim}(${tail})${c.reset}${wait}`);
    }
    if (this.#workerStripVisible()) out.push(...this.#workerLines(inner));
    if (this.#busy || this.#approval || this.#workerStripVisible()) out.push('');
    const rule = `${c.dim}${'─'.repeat(inner)}${c.reset}`;
    out.push(rule);
    if (this.#inputActive) {
      const cursor = Math.floor(now / 500) % 2 === 0 ? '█' : ' ';
      const text = sanitizeTerminalText(this.#inputText);
      const room = inner - 4;
      const shown = visibleLength(text) > room ? '…' + text.slice(-(room - 1)) : text;
      out.push(`${c.bold}❯${c.reset} ${shown}${cursor}`);
    } else {
      out.push(`${c.dim}❯${c.reset}`);
    }
    out.push(rule);
    const palette = this.#paletteItems();
    if (palette) {
      const n = palette.items.length;
      const start = Math.min(Math.max(0, this.#paletteIndex - PALETTE_ROWS + 1), Math.max(0, n - PALETTE_ROWS));
      const nameW = Math.min(26, Math.max(...palette.items.map((x) => x.name.length + (x.args ? x.args.length + 1 : 0))) + 2);
      for (const [k, cmd] of palette.items.slice(start, start + PALETTE_ROWS).entries()) {
        const sel = start + k === this.#paletteIndex;
        const name = `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`.padEnd(nameW + 1);
        out.push(`  ${sel ? `${c.blue}${name}${c.reset}` : `${c.dim}${name}${c.reset}`} ${sel ? '' : c.dim}${sanitizeTerminalText(cmd.description)}${cmd.source === 'user' ? ' (user)' : ''}${c.reset}`);
      }
      return out;
    }
    const tokens = this.#sessionTokens || this.#uiTokens;
    const right = [tokens ? `${formatTokens(tokens)} tokens` : '', this.#orchContextPct != null ? `ctx ${this.#orchContextPct}%` : ''].filter(Boolean).join(' · ');
    const left = this.#flash && now < this.#flash.until ? `  ${c.amber}${this.#flash.text}${c.reset}` : `  ${this.#modeLine()}`;
    out.push(spread(left, right ? `${c.dim}${right}${c.reset}` : '', inner));
    return out;
  }

  #repaint() {
    this.#frameBuffer.reset();
    this.#paint();
  }

  #spinner() {
    return SPINNER[Math.floor(Date.now() / TICK_MS) % SPINNER.length];
  }

  #headerLine(width: number) {
    const mode = this.#swarm.getMode?.();
    const left = `${c.bold} swarm${c.reset} ${c.dim}· ${sanitizeTerminalText(this.#title.replace(/^swarm · /, ''))}${c.reset}`;
    const tokens = this.#sessionTokens || this.#uiTokens;
    const ctx = this.#orchContextPct != null ? `ctx ${this.#orchContextPct}%` : tokens && this.#contextSize ? `ctx ${Math.round((tokens / this.#contextSize) * 1000) / 10}%` : '';
    const right = [
      tokens ? `${formatTokens(tokens)} tok` : '',
      ctx,
      mode ? `${modeColor[mode]}${mode}${c.reset}${c.dim}` : '',
    ].filter(Boolean).join(' · ');
    return spread(left, right ? `${c.dim}${right}${c.reset} ` : '', width);
  }

  #workerStripVisible() {
    if (this.#workerStrip !== 'auto') return this.#workerStrip === 'on';
    return [...this.#workers.values()].some((w) => w.endedAt == null || Date.now() - w.endedAt < 10_000);
  }

  #workerLines(width: number): string[] {
    const now = Date.now();
    const used = new Set([...this.#workers.values()].map((w) => w.worker));
    return (['beam', 'deepseek', 'minimax'] as const).filter((k) => k !== 'minimax' || used.has(k)).map((k) => {
      const a = AGENTS[k];
      const mine = [...this.#workers.values()].filter((w) => w.worker === k);
      const active = mine.filter((w) => w.endedAt == null);
      const label = `${a.color}●${c.reset} ${a.color}${a.name}${c.reset} ${c.dim}${a.model}${c.reset}`;
      if (!active.length) {
        const last = mine.at(-1);
        const tail = last && last.endedAt && now - last.endedAt < 10_000 ? ` ${c.dim}· ${last.taskId} ${last.status}${c.reset}` : '';
        return fit(`  ${label}  ${c.dim}idle${c.reset}${tail}`, width);
      }
      const w = active.at(-1)!;
      const more = active.length > 1 ? ` ${c.dim}+${active.length - 1} more${c.reset}` : '';
      return fit(`  ${label}  ${c.yellow}${STAR[Math.floor(Date.now() / 120) % STAR.length]}${c.reset} ${w.status} ${c.dim}(${formatDuration(now - w.since)})${c.reset} ${c.dim}·${c.reset} ${w.taskId}${w.attempt > 1 ? ` ${c.amber}attempt ${w.attempt}${c.reset}` : ''}${more}`, width);
    });
  }

  #footerLines(width: number): string[] {
    const out: string[] = [];
    const palette = this.#paletteItems();
    if (palette) {
      const n = palette.items.length;
      const start = Math.min(Math.max(0, this.#paletteIndex - PALETTE_ROWS + 1), Math.max(0, n - PALETTE_ROWS));
      const nameW = Math.min(24, Math.max(...palette.items.map((x) => x.name.length + (x.args ? x.args.length + 1 : 0))) + 2);
      out.push(`${c.dim}${'╌'.repeat(width)}${c.reset}`);
      for (const [i, cmd] of palette.items.slice(start, start + PALETTE_ROWS).entries()) {
        const sel = start + i === this.#paletteIndex;
        const name = `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`.padEnd(nameW + 1);
        const src = cmd.source === 'user' ? ' (user)' : '';
        out.push(fit(`${sel ? `${c.magenta}› ${c.bold}` : '  '}${name}${c.reset} ${c.dim}${sanitizeTerminalText(cmd.description)}${src}${c.reset}`, width));
      }
      if (n > PALETTE_ROWS) out.push(`${c.dim}  ${this.#paletteIndex + 1}/${n} · ↑/↓ select · Tab complete · Enter run · Esc close${c.reset}`);
    } else if (this.#workerStripVisible()) {
      out.push(...this.#workerLines(width));
    }
    out.push(`${c.dim}${'─'.repeat(width)}${c.reset}`);
    out.push(this.#inputLine(width));
    out.push(this.#statusLine(width));
    return out;
  }

  #inputLine(width: number) {
    if (this.#approval) {
      return `${c.amber}⚠ approve?${c.reset} ${c.bold}[y]${c.reset} yes ${c.bold}[n]${c.reset} no ${c.dim}·${c.reset} ${sanitizeTerminalText(this.#approval.text)}`;
    }
    if (!this.#inputActive) {
      return `${c.dim}› Swarm running… press Esc to cancel${c.reset}`;
    }
    const cursor = Math.floor(Date.now() / 500) % 2 === 0 ? '█' : ' ';
    if (!this.#inputText) return `${c.magenta}›${c.reset} ${cursor}${c.dim}Type a message or / for commands${c.reset}`;
    // Show the tail of long input so the cursor stays visible.
    const text = sanitizeTerminalText(this.#inputText);
    const room = width - 4;
    const shown = visibleLength(text) > room ? '…' + text.slice(-(room - 1)) : text;
    return `${c.magenta}›${c.reset} ${c.bold}${shown}${c.reset}${cursor}`;
  }

  #statusLine(width: number) {
    const now = Date.now();
    const mode = this.#swarm.getMode?.();
    const modeTag = mode ? `${modeColor[mode]}${mode}${c.reset} ` : '';
    let left: string;
    let hints: string;
    if (this.#flash && now < this.#flash.until) {
      left = `${c.amber}${this.#flash.text}${c.reset}`;
    } else if (this.#approval) {
      left = `${c.amber}⚠ waiting for your approval${c.reset}`;
    } else if (this.#busy) {
      const h = this.#headline;
      const a = AGENTS[h.agent];
      const stalled = now - this.#lastEventAt > STALL_MS;
      const t = formatDuration(now - h.since);
      const timer = stalled ? `${c.amber}(${t}) (waiting on API…)${c.reset}` : `${c.dim}(${t})${c.reset}`;
      const attempt = h.attempt && h.attempt > 1 ? ` ${c.dim}·${c.reset} ${c.amber}attempt ${h.attempt}${c.reset}` : '';
      left = `${c.yellow}${this.#spinner()}${c.reset} ${a.color}${a.name}${c.reset} ${c.dim}·${c.reset} ${sanitizeTerminalText(h.label)} ${timer}${attempt} ${c.dim}· total ${formatDuration(now - this.#turnStart)}${c.reset}`;
    } else if (this.#outcome) {
      left = `${toneColor[this.#outcome.tone]}${this.#outcome.text}${c.reset} ${c.dim}· Ready${c.reset}`;
    } else {
      left = `${c.green}Ready${c.reset}`;
    }
    if (this.#busy) hints = 'Esc cancel · [ ] focus · e toggle · E all · w workers · ⇧Tab mode';
    else hints = 'Enter send · / commands · ⇧Tab mode · Ctrl+O expand · Ctrl+C×2 quit';
    if (mode && !this.#busy) hints = `${MODE_HELP[mode]} · ${hints}`;
    return spread(`${modeTag}${left}`, `${c.dim}${hints}${c.reset}`, width);
  }

  #visibleBodyLines(bodyContentHeight: number) {
    if (this.#sections.length === 0) {
      return ['', `  ${c.dim}Waiting for input. Type a message, or / for commands.${c.reset}`];
    }
    const width = this.#bodyWidth();
    const total = this.#bodyLineCount();
    const start = Math.max(0, total - bodyContentHeight - this.#scrollOffset);
    const end = start + bodyContentHeight;
    const visible: string[] = [];
    let sectionStart = 0;
    for (const section of this.#sections) {
      const lines = this.#sectionLines(section, width);
      const sectionEnd = sectionStart + lines.length;
      if (sectionEnd > start && sectionStart < end) {
        visible.push(...lines.slice(Math.max(0, start - sectionStart), end - sectionStart));
      }
      if (visible.length >= bodyContentHeight) break;
      sectionStart = sectionEnd;
    }
    return visible;
  }

  #sectionLines(section: ChatSection, width: number): string[] {
    const focused = section.id != null && section.id === this.#focusId;
    const expanded = this.#isExpanded(section);
    // Tool rows depend on time (spinner/durations): never cached. Text sections are cached by content.
    if (section.kind !== 'tool') {
      const key = `${width}|${section.kind}|${section.title}|${section.rightTitle}|${section.content}|${focused}|${expanded}|${section.tone}`;
      if (section.cache?.key === key) return section.cache.lines;
      const lines = this.#renderTextSection(section, width, focused, expanded);
      section.cache = { key, lines };
      return lines;
    }
    return this.#renderToolSection(section, width, focused, expanded);
  }

  #renderTextSection(s: ChatSection, width: number, focused: boolean, expanded: boolean): string[] {
    const inner = Math.max(10, width - 2);
    const wrap = (text: string) => text.split('\n').flatMap((l) => wrapVisibleLine(l, inner));
    if (s.kind === 'note' || s.kind === 'banner') {
      const col = toneColor[s.tone ?? 'info'];
      return ['', ...wrap(sanitizeTerminalText(s.content, { multiline: true })).map((l) => `  ${col}${l}${c.reset}`)];
    }
    if (s.kind === 'reasoning') {
      const lines = sanitizeTerminalText(s.content, { multiline: true }).split('\n');
      const head = `${focused ? c.inverse : ''}${c.dim}${expanded ? '▾' : '▸'} thinking${c.reset}${c.dim} (${lines.length} line${lines.length === 1 ? '' : 's'})${c.reset}`;
      return expanded ? [head, ...wrap(lines.join('\n')).map((l) => `  ${c.dim}${c.italic}${l}${c.reset}`)] : [head];
    }
    const agent = s.agent ?? (s.kind === 'error' ? undefined : 'orch');
    const color = s.kind === 'error' ? c.red : AGENTS[agent ?? 'orch'].color;
    const bar = `${color}▌${c.reset} `;
    const right = s.rightTitle ? `  ${c.dim}${sanitizeTerminalText(s.rightTitle)}${c.reset}` : '';
    const header = `${bar}${color}${c.bold}${sanitizeTerminalText(s.title)}${c.reset}${right}`;
    // User text and errors are literal; only the orchestrator's prose is Markdown.
    const body = s.kind === 'assistant' ? renderMarkdown(s.content) : sanitizeTerminalText(s.content, { multiline: true });
    return ['', header, ...wrap(body).map((l) => `${bar}${l}${c.reset}`)];
  }

  #renderToolSection(s: ChatSection, width: number, focused: boolean, expanded: boolean): string[] {
    const t = s.tool!;
    const times = this.#toolTimes.get(t.callId);
    const ms = times ? (times.end ?? Date.now()) - times.start : undefined;
    const inner = Math.max(10, width - 6);
    const wrap = (text: string) => text.split('\n').flatMap((l) => wrapVisibleLine(l, inner));

    if (t.name === 'dispatch') {
      const progress = (t.output && typeof t.output === 'object' ? t.output : undefined) as DispatchProgress | undefined;
      const input = (t.input ?? {}) as DispatchInput;
      const w = input.id ? this.#workers.get(input.id) : undefined;
      const card = dispatchCard({
        input, progress, finished: t.finished, expanded, focused, ms, spinner: this.#spinner(),
        live: w && w.endedAt == null ? `${w.status} (${formatDuration(Date.now() - w.since)})` : undefined,
      });
      const bar = `${card.color}▎${c.reset} `;
      return ['', `${bar}${card.header}`, ...card.body.flatMap((l) => wrapVisibleLine(l, inner)).map((l) => `${bar}  ${l}${c.reset}`)];
    }

    const row = `  ${compactRow({ tool: t.name, arg: keyArg(t.name, t.input), ms, state: t.state, focused, expanded, spinner: this.#spinner() })}`;
    const lines = [row];
    if (!expanded && t.state === 'error') {
      const first = sanitizeTerminalText(String(t.errorText ?? t.output ?? '')).split('\n')[0];
      if (first) lines.push(`    ${c.red}${first.slice(0, inner)}${c.reset}`);
    }
    if (expanded) {
      const gutter = `    ${c.dim}│${c.reset} `;
      lines.push(...wrap(formatPayload(t.input)).map((l) => gutter + l));
      if (t.errorText != null) lines.push(`    ${c.dim}├ error${c.reset}`, ...wrap(sanitizeTerminalText(t.errorText, { multiline: true })).map((l) => gutter + c.red + l + c.reset));
      else if (t.output !== undefined) lines.push(`    ${c.dim}├ output${c.reset}`, ...wrap(formatPayload(t.output)).map((l) => gutter + l));
    }
    return lines;
  }

  #clampScrollOffset(scrollOffset: number) {
    const max = Math.max(0, this.#bodyLineCount() - this.#bodyContentHeight());
    return Math.min(Math.max(0, scrollOffset), max);
  }

  #bodyLineCount() {
    if (this.#sections.length === 0) return 2;
    const width = this.#bodyWidth();
    let count = 0;
    for (const s of this.#sections) count += this.#sectionLines(s, width).length;
    return count;
  }

  #bodyContentHeight() {
    return Math.max(1, this.#height() - 1 - this.#footerLines(this.#width()).length);
  }

  #handleScroll(direction: 'up' | 'down', lines = 1) {
    const delta = direction === 'up' ? lines : -lines;
    this.#scrollOffset = this.#clampScrollOffset(this.#scrollOffset + delta);
    this.#paint();
  }

  #handlePageScroll(direction: 'page-up' | 'page-down') {
    this.#handleScroll(direction === 'page-up' ? 'up' : 'down', this.#bodyContentHeight());
  }

  #bodyWidth() {
    return this.#width() - 1;
  }

  #width() {
    return Math.max(20, this.#output.columns ?? 80);
  }

  #height() {
    return Math.max(8, this.#output.rows ?? 24);
  }
}

// Pad or cut a styled line to exactly `width` visible columns, always ending with a reset.
function fit(line: string, width: number) {
  const s = sliceVisible(line, width);
  return s + ' '.repeat(Math.max(0, width - visibleLength(s))) + c.reset;
}

// Cut to width without padding: inline lines go to scrollback, trailing spaces would pollute copy/paste.
function clip(line: string, width: number) {
  return visibleLength(line) > width ? sliceVisible(line, width) + c.reset : line;
}

function spread(left: string, right: string, width: number) {
  const lw = visibleLength(left);
  const room = width - lw - 2;
  if (room < 12) return fit(left, width); // left side (state) always wins; hints are optional
  const r = visibleLength(right) > room ? sliceVisible(right, room - 1) + '…' + c.reset : right;
  return left + ' '.repeat(Math.max(1, width - lw - visibleLength(r))) + r;
}

function interruptedError() {
  return new Error('Interrupted');
}

async function* takeUntil<T>(source: AsyncIterable<T>, stop: Promise<void>): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  const stopped = stop.then(() => ({ done: true, value: undefined as T }) satisfies IteratorResult<T>);
  while (true) {
    const nextValue = await Promise.race([iterator.next(), stopped]);
    if (nextValue.done) break;
    yield nextValue.value;
  }
}

function formatStreamError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function sectionId(messageId: string, partIndex: number) {
  return `${messageId}:${partIndex}`;
}

function toReadableStream(
  stream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  if (stream instanceof ReadableStream) return stream;
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) controller.enqueue(chunk);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

async function* iterateUIMessageStream(
  stream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>,
): AsyncIterable<UIMessageChunk> {
  if (stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield* stream as AsyncIterable<UIMessageChunk>;
}

export function wrapVisibleLine(line: string, width: number): string[] {
  if (line.length === 0) return [''];
  const lines: string[] = [];
  let remaining = line;
  while (visibleLength(remaining) > width) {
    const breakAt = findVisibleBreakPoint(remaining, width);
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function findVisibleBreakPoint(input: string, width: number) {
  const slice = sliceVisible(input, width + 1);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return lastSpace;
  return sliceVisible(input, width).length;
}

function removeLastGrapheme(value: string) {
  let lastGraphemeIndex = 0;
  for (const { index } of graphemeSegmenter.segment(value)) lastGraphemeIndex = index;
  return value.slice(0, lastGraphemeIndex);
}

export function parseKey(chunk: Buffer): TerminalKey {
  const value = chunk.toString('utf8');
  switch (value) {
    case '\u000c': return { type: 'ctrl-l' };
    case '\u0003': return { type: 'ctrl-c' };
    case '\u0005': return { type: 'ctrl-e' };
    case '\u000f': return { type: 'ctrl-o' };
    case '\u0010': return { type: 'ctrl-p' };
    case '\u000e': return { type: 'ctrl-n' };
    case '\t': return { type: 'tab' };
    case '\x1B[Z': return { type: 'shift-tab' };
    case '\x1B': return { type: 'escape' };
    case '\r':
    case '\n': return { type: 'enter' };
    case '\u007f':
    case '\b': return { type: 'backspace' };
    case '\x1B[A':
    case '\x1BOA': return { type: 'up' };
    case '\x1B[B':
    case '\x1BOB': return { type: 'down' };
    case '\x1B[1;5A': return { type: 'ctrl-up' };
    case '\x1B[1;5B': return { type: 'ctrl-down' };
    case '\x1B[5~': return { type: 'page-up' };
    case '\x1B[6~': return { type: 'page-down' };
    default:
      if (value.length > 0 && !value.startsWith('\x1B') && value >= ' ' && value !== '\x7F') {
        return { type: 'character', value };
      }
      return { type: 'ignore' };
  }
}
