// Offline TUI harness: scripted mock models, no gateway calls. `node src/tui/dev.ts [dir]`
// Used to screenshot/verify TUI changes in an isolated tmux server.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwarm, ORCHESTRATOR_CONTEXT } from '../swarm.ts';
import { scripted } from '../mock.ts';
import { runAgentTUI } from './index.ts';
import { createHost } from './host.ts';

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'swarm-tui-dev-'));
writeFileSync(join(dir, 'app.py'), 'def load_registry():\n    return {}\n\ndef cmd_wake():\n    pass\n');
const slow = Number(process.env.DEV_DELAY_MS ?? 400);

const { host, emit, gate, enforcePlanMode } = createHost({ titleLabel: 'dev' });
const swarm = createSwarm(dir, {
  emit,
  gate,
  models: {
    orch: scripted('orch', [
      { delayMs: slow, text: 'Reading the code first.', tools: [{ name: 'list_files', input: { dir: '.' } }, { name: 'read_file', input: { path: 'app.py' } }] },
      {
        delayMs: slow,
        tools: [{
          name: 'dispatch',
          input: {
            id: 'fix-cmd-wake', kind: 'bugfix', files: ['app.py'], estTokens: 4000,
            goal: 'Fix cmd_wake in app.py:\n- it must call load_registry()\n- keep "pass" semantics for empty registries\nEnd with STATUS: ok',
          },
        }],
      },
      {
        delayMs: slow,
        text: '## Done\n\n- `cmd_wake` now calls load_registry and sync_registry stays untouched.\n- Risk: **none** found; snake_case like recover_agent_by_title must not italicise.\n\n| task | worker | status |\n|---|---|---|\n| fix-cmd-wake | beam | ok |',
      },
    ]),
    beam: scripted('beam', [
      { delayMs: slow, tools: [{ name: 'read_file', input: { path: 'app.py' } }] },
      { delayMs: slow, tools: [{ name: 'edit_file', input: { path: 'app.py', old_string: '    pass', new_string: '    return load_registry()' } }] },
      { delayMs: slow, tools: [{ name: 'run_command', input: { command: 'python3 -c "import app; print(app.cmd_wake())"' } }] },
      { delayMs: slow, text: 'STATUS: ok\nEdited app.py: cmd_wake returns load_registry().' },
    ]),
  },
});

enforcePlanMode(swarm as unknown as { tools: Record<string, { execute?: unknown }> });
await runAgentTUI({ title: `dev · ${dir}`, agent: swarm, tools: 'auto-collapsed', contextSize: ORCHESTRATOR_CONTEXT, swarm: host });
