// Scripted offline models (ai/test) — for engine tests and the web console's --mock mode. No gateway calls.
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';

export type MockTurn = { text?: string; tools?: { name: string; input: unknown }[]; delayMs?: number; fail?: string; tokens?: number };

// Each model call consumes the next turn; when the script runs out the model answers `done`.
export function scripted(modelId: string, turns: MockTurn[] | ((callNo: number, prompt: string) => MockTurn)) {
  let n = 0;
  const next = (prompt: unknown) => {
    const i = n++;
    const t = typeof turns === 'function' ? turns(i, JSON.stringify(prompt)) : (turns[i] ?? { text: 'done' });
    if (t.fail) throw Object.assign(new Error(t.fail), { statusCode: /rate/i.test(t.fail) ? 429 : 500, isRetryable: false });
    return { i, t };
  };
  const usage = (tok: number) => ({ inputTokens: { total: tok, noCache: tok, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 80, text: 80, reasoning: 0 } });
  const reason = (t: MockTurn) => ({ unified: t.tools?.length ? 'tool-calls' as const : 'stop' as const, raw: undefined });
  const calls = (i: number, t: MockTurn) =>
    (t.tools ?? []).map((c, k) => ({ type: 'tool-call' as const, toolCallId: `${modelId}-${i}-${k}`, toolName: c.name, input: JSON.stringify(c.input) }));
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async ({ prompt }) => {
      const { i, t } = next(prompt);
      if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
      return { content: [...(t.text ? [{ type: 'text' as const, text: t.text }] : []), ...calls(i, t)], finishReason: reason(t), usage: usage(t.tokens ?? 1200), warnings: [] };
    },
    doStream: async ({ prompt }) => {
      const { i, t } = next(prompt);
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (t.text) {
        parts.push({ type: 'text-start', id: 't' });
        for (const w of t.text.match(/\S+\s*/g) ?? []) parts.push({ type: 'text-delta', id: 't', delta: w });
        parts.push({ type: 'text-end', id: 't' });
      }
      parts.push(...calls(i, t), { type: 'finish', finishReason: reason(t), usage: usage(t.tokens ?? 1200) });
      return { stream: simulateReadableStream({ chunks: parts as never[], chunkDelayInMs: t.delayMs ?? 0 }) };
    },
  });
}
