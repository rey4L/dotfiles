// Run a shell command under bubblewrap: no network, host read-only (/nix, /etc, /run/current-system),
// $HOME hidden, only the workspace writable. Free and local; needs unprivileged user namespaces.
import { execFile } from 'node:child_process';
import { readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';

const TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 8_000;

export function bwrapArgs(root: string, command: string): string[] {
  return [
    '--ro-bind', '/nix', '/nix',
    '--ro-bind', '/run/current-system', '/run/current-system',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/usr', '/usr',
    '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', '/home', // tmpfs first: the workspace bind below must sit on top
    '--bind', root, root,
    ...linkedDepBinds(root),
    '--unshare-all', '--die-with-parent', '--clearenv',
    '--setenv', 'PATH', process.env.PATH ?? '/run/current-system/sw/bin',
    '--setenv', 'HOME', '/tmp',
    '--chdir', root,
    '--', 'bash', '-c', command,
  ];
}

// `file:` dependencies are symlinks in node_modules pointing outside the workspace (hidden by the /home tmpfs), so
// typechecks inside the sandbox silently lost their types. Mount each target read-only, with every .env* file inside
// it masked by /dev/null: a linked package can hold secrets (dot-swarm's .env has the gateway key).
export function linkedDepBinds(root: string): string[] {
  const out: string[] = [];
  const nm = join(root, 'node_modules');
  let entries: string[] = [];
  try { entries = readdirSync(nm); } catch { return out; }
  const names = entries.flatMap((e) => {
    if (!e.startsWith('@')) return [e];
    try { return readdirSync(join(nm, e)).map((x) => `${e}/${x}`); } catch { return []; }
  });
  for (const n of names) {
    try {
      if (!lstatSync(join(nm, n)).isSymbolicLink()) continue;
      const target = realpathSync(join(nm, n));
      if (target === root || target.startsWith(root + sep)) continue;
      out.push('--ro-bind', target, target);
      for (const f of readdirSync(target)) if (/^\.env/.test(f)) out.push('--ro-bind', '/dev/null', join(target, f));
    } catch { /* broken link: skip */ }
  }
  return out;
}

export function runSandboxed(root: string, command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((done) => {
    execFile('bwrap', bwrapArgs(root, command), { timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number | string }).code ?? 'error') : 0;
        const timedOut = err && (err as { killed?: boolean }).killed ? ` (killed after ${TIMEOUT_MS / 1000}s)` : '';
        done(`exit=${code}${timedOut}\n${(stdout + stderr).slice(-MAX_OUTPUT)}`);
      });
  });
}
