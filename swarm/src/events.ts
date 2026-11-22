// Live event stream for UIs (superset of the durable journal). Optional: the TUI never subscribes.
export type AgentId = 'orch' | `task:${string}`;
export type AgentStatus =
  | 'idle' | 'queued' | 'thinking' | 'tool' | 'awaiting_approval' | 'paused' | 'error' | 'done' | 'cancelled';
export type Usage = { in: number; out: number; reasoning?: number; cacheRead?: number };

export type SwarmEvent =
  | { type: 'text.delta'; agent: AgentId; delta: string } // ephemeral
  | { type: 'step.end'; agent: AgentId; text: string; model: string; usage: Usage; ms: number; contextPct: number; gateway?: unknown }
  | { type: 'agent.status'; agent: AgentId; status: AgentStatus; detail?: string }
  | { type: 'dispatch'; taskId: string; kind: string; goal: string; files: string[]; estTokens: number;
      worker: 'beam' | 'flint'; reason: string; attempt: number; forcedBy?: 'user' }
  | { type: 'lease.conflict'; taskId: string; files: string[]; heldBy: string[] }
  | { type: 'tool.start'; agent: AgentId; callId: string; tool: string; input: unknown }
  | { type: 'tool.end'; agent: AgentId; callId: string; ok: boolean; outputTail: string }
  | { type: 'file.read'; agent: AgentId; path: string }
  | { type: 'file.edit'; agent: AgentId; editId: string; path: string; op: 'create' | 'edit';
      beforeHash: string | null; afterHash: string; before?: string; after?: string }
  | { type: 'task.result'; taskId: string; worker: 'beam' | 'flint'; status: 'ok' | 'failed' | 'stuck' | 'cancelled'; summary: string }
  | { type: 'human.input'; question: string }
  | { type: 'ratelimit'; model: string; message: string }
  | { type: 'error'; agent?: AgentId; message: string };

export type Emit = (e: SwarmEvent) => void;

// Human-in-the-loop hooks. Absent = auto-approve, never pause (the TUI's behavior).
export interface Gate {
  beforeTool(agent: AgentId, tool: string, input: unknown, why: string, signal?: AbortSignal): Promise<{ approve: boolean; input?: unknown }>;
  checkpoint(agent: AgentId, signal?: AbortSignal): Promise<void>;
}
