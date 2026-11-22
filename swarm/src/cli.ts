// Entry point used by `dot-agent-persist swarm`.
//   cli.ts tui [dir] [--resume <runId>]             interactive terminal UI
//   cli.ts run "<request>" [dir] [--resume <runId>]  one-shot, prints the final report
// Every run journals to $XDG_STATE_HOME/tmux-agents/swarm/<runId>.jsonl.
import { runAgentTUI } from './tui/index.ts';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSwarm, ORCHESTRATOR_CONTEXT } from './swarm.ts';
import { openJournal, readJournal, summarize } from './journal.ts';
import { createHost } from './tui/host.ts';

const argv = process.argv.slice(2);
const ri = argv.indexOf('--resume');
const resumeOf = ri >= 0 ? argv.splice(ri, 2)[1] : undefined;
const [mode, ...rest] = argv;

if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
  console.error('swarm: no AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN. Put it in ~/dotfiles/swarm/.env (chmod 600) or export it.');
  process.exit(2);
}
if ((mode !== 'tui' && mode !== 'run') || (mode === 'run' && !rest[0])) {
  console.error('usage: cli.ts tui [dir] | run "<request>" [dir]  [--resume <runId>]');
  process.exit(1);
}

let dir = resolve((mode === 'tui' ? rest[0] : rest[1]) ?? process.cwd());
const newRunId = () => `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(2).toString('hex')}`;
let resumeFrom = resumeOf;

// One iteration per TUI session; `/resume <run>` ends the session and starts the next one on that run.
while (true) {
  const runId = newRunId();
  const journal = openJournal(runId);
  const prior = resumeFrom ? readJournal(resumeFrom) : undefined;
  const resumeContext = prior ? summarize(prior) : undefined;
  journal({ type: 'start', dir, mode, pid: process.pid, resumeOf: resumeFrom });
  let next: string | undefined;

  try {
    if (mode === 'tui') {
      const { host, emit, gate, enforcePlanMode } = createHost({ runId, titleLabel: basename(dir), onResume: (id) => { next = id; } });
      const swarm = createSwarm(dir, { journal, resumeContext, emit, gate });
      enforcePlanMode(swarm as unknown as { tools: Record<string, { execute?: unknown }> });
      await runAgentTUI({
        title: `${basename(dir)} · ${runId}${resumeFrom ? ` · resumed ${resumeFrom}` : ''}`,
        agent: swarm, tools: 'auto-collapsed', contextSize: ORCHESTRATOR_CONTEXT, swarm: host,
      });
    } else {
      const swarm = createSwarm(dir, { journal, resumeContext });
      console.error(`swarm run ${runId}`);
      const result = await swarm.generate({ prompt: rest[0] });
      console.log(result.text);
    }
    journal({ type: 'end', status: 'done' });
  } catch (e) {
    journal({ type: 'error', message: (e as Error).message });
    journal({ type: 'end', status: 'error' });
    throw e;
  }
  if (!next) break;
  resumeFrom = next;
  const start = readJournal(next).find((e) => e.type === 'start');
  if (start?.type === 'start') dir = start.dir;
}
