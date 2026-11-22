import { AgentTUIRunner } from './agent-tui-runner.ts';
import type { SwarmEvent } from '../events.ts';
import type { Command, Mode } from './tui/commands.ts';
import type {
  Agent,
  ChatTransport,
  Experimental_SandboxSession,
  UIMessage,
} from 'ai';

/**
 * Controls how terminal UI sections for stream parts are displayed.
 *
 * - `full`: show the section header and full content.
 * - `collapsed`: show only the section header.
 * - `auto-collapsed`: show the latest section expanded until another visible
 *   section appears, then collapse it.
 * - `hidden`: omit the section entirely.
 */
export type TerminalPartDisplayMode =
  | 'full'
  | 'collapsed'
  | 'auto-collapsed'
  | 'hidden';

/**
 * Controls which response statistic is shown.
 *
 * - `outputTokenCount`: show the number of output tokens in the response.
 * - `outputTokensPerSecond`: show output token throughput for the response.
 */
export type ResponseStatisticsMode =
  | 'outputTokenCount'
  | 'outputTokensPerSecond';

/**
 * An agent that is compatible with the terminal UI.
 */
export type AgentTUIAgent = Agent<any, any, any, any>;

/**
 * Options for starting an agent in the default terminal UI.
 */
export type RunAgentTUIOptions = {
  /**
   * The title shown in the terminal UI.
   */
  title?: string;

  /**
   * How tool calls should render.
   *
   * @default "auto-collapsed"
   */
  tools?: TerminalPartDisplayMode;

  /**
   * How reasoning parts should render.
   *
   * @default "auto-collapsed"
   */
  reasoning?: TerminalPartDisplayMode;

  /**
   * Which response statistic to show.
   *
   * @default "outputTokensPerSecond"
   */
  responseStatistics?: ResponseStatisticsMode;

  /**
   * The model context window size in tokens.
   *
   * When provided, the terminal UI shows the current total token usage as a
   * percentage of this context window.
   */
  contextSize?: number;

  /**
   * swarm: host hooks for the swarm UI (events, modes, slash commands, resume). Optional.
   */
  swarm?: SwarmTUIHost;
} & (
  | {
      /**
       * The agent to run.
       */
      agent: AgentTUIAgent;
      transport?: never;

      /**
       * Sandbox session that is passed through to agent tool execution.
       */
      sandbox?: Experimental_SandboxSession;
    }
  | {
      agent?: never;

      /**
       * The transport used to communicate with a remote agent.
       */
      transport: ChatTransport<UIMessage>;
      sandbox?: never;
    }
);

/**
 * Runs an agent in the default terminal UI until the user exits.
 */
export async function runAgentTUI(options: RunAgentTUIOptions) {
  await new AgentTUIRunner(options).run();
}

// swarm: what the host (cli.ts) provides to the TUI.
export type SwarmTUIHost = {
  events?: { on(listener: (e: SwarmEvent) => void): void };
  titleLabel?: string;
  getMode(): Mode;
  setMode(mode: Mode): void;
  planNext(): void;
  wrapPrompt(prompt: string): string; // applies plan mode to the text the agent sees
  commands(): Command[];
  status(): string;
  models(): string;
  runs(): string[];
  compactSummary(): string;
  resume(runId: string): void; // called before the TUI exits so the host can restart on that run
  approvals?: { set(handler: (text: string) => Promise<boolean>): void }; // ask-mode prompts
};
