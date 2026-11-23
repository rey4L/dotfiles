// Agent mailbox: messages between the orchestrator, workers, the human and the system, delivered at step boundaries
// (OpenRig's hook-bridge idea: never mid-step, so a model sees a message as the next user turn).
// External senders (`dot-agent-persist swarm send`) append JSON lines to <runId>.inbox; it is read at each drain.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Journal } from './journal.ts';
import type { Emit } from './events.ts';

export type Address = 'orch' | 'human' | 'system' | `task:${string}`;
export type Msg = { id: string; from: string; to: Address; text: string; inReplyTo?: string };

export const envelope = (ms: Msg[]) =>
  ms.map((m) => `From: ${m.from}\nTo: ${m.to}\nMessage-Id: ${m.id}${m.inReplyTo ? `\nIn-Reply-To: ${m.inReplyTo}` : ''}\n---\n${m.text}`).join('\n\n');

export function createMailbox(log: Journal, emit: Emit, inboxPath?: string, isLive: (to: Address) => boolean = () => true) {
  const queue: Msg[] = [];
  let offset = 0;

  const send = (m: Omit<Msg, 'id'> & { id?: string }): Msg => {
    let msg: Msg = { ...m, id: m.id ?? randomUUID().slice(0, 8) };
    // A message to a task that is not running would never be read: hand it to the orchestrator instead.
    if (msg.to.startsWith('task:') && !isLive(msg.to)) msg = { ...msg, to: 'orch', text: `(for ${msg.to}, which is not running) ${msg.text}` };
    if (msg.to !== 'human' && msg.to !== 'system') queue.push(msg); // human/system: event + journal only
    log({ type: 'msg', ...msg, state: 'queued' });
    emit({ type: 'message', ...msg });
    return msg;
  };

  // shortcut: polled at drain time, not watched; an idle orchestrator sees inbox lines only when its next turn starts.
  const pollInbox = () => {
    if (!inboxPath) return;
    let fd: number;
    try { fd = openSync(inboxPath, 'r'); } catch { return; }
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n') + 1; // only whole lines; a half-written line is read next time
      offset += Buffer.byteLength(text.slice(0, end));
      for (const line of text.slice(0, end).split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line) as { to?: string; from?: string; text?: string; inReplyTo?: string };
          if (typeof j.text !== 'string' || !j.text.trim()) continue;
          const to = j.to && j.to !== 'orch' ? (j.to.startsWith('task:') ? j.to : `task:${j.to}`) as Address : 'orch';
          send({ from: `external:${j.from ?? 'cli'}`, to, text: j.text, inReplyTo: j.inReplyTo });
        } catch { /* skip malformed lines */ }
      }
    } finally { closeSync(fd); }
  };

  // Remove and return everything addressed to `to`.
  const take = (to: Address): Msg[] => {
    pollInbox();
    const mine = queue.filter((m) => m.to === to);
    if (!mine.length) return [];
    for (const m of mine) {
      queue.splice(queue.indexOf(m), 1);
      log({ type: 'msg', id: m.id, from: m.from, to: m.to, text: '', state: 'delivered' });
    }
    return mine;
  };

  return { send, take, pollInbox };
}
export type Mailbox = ReturnType<typeof createMailbox>;
