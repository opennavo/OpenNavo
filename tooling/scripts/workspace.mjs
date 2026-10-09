// Unified command entry point: dispatch only.
// Backend tasks live in tooling/scripts/tasks/server.mjs (backend-owned); frontend tasks in tooling/scripts/tasks/frontend.mjs (frontend-owned).
// Tasks ending in -server / -web run only that side, for example `make lint-server`.
import { spawnSync } from 'node:child_process';
import * as server from './tasks/server.mjs';
import * as frontend from './tasks/frontend.mjs';

const task = process.argv[2] ?? 'help';
const aggregates = new Set(['lint', 'test', 'build', 'gen']);

if (task === 'setup') {
  for (const [command, args] of [
    ['node', ['--version']],
    ['pnpm', ['--version']],
    ['go', ['version']],
    ['rustc', ['-V']],
    ['pnpm', ['install']]
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: command === 'rustc' ? 'apps/desktop/src-tauri' : undefined });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} else if (aggregates.has(task)) {
  // gen must generate Go before TS; other tasks run backend before frontend.
  server.runTask(task);
  server.runMCP(task);
  frontend.runTask(task);
} else if (task.endsWith('-server') && aggregates.has(task.slice(0, -'-server'.length))) {
  server.runTask(task.slice(0, -'-server'.length));
} else if (task.endsWith('-web') && aggregates.has(task.slice(0, -'-web'.length))) {
  frontend.runTask(task.slice(0, -'-web'.length));
} else if (server.tasks.has(task)) {
  server.runTask(task);
} else if (frontend.tasks.has(task)) {
  frontend.runTask(task);
} else {
  console.error(`Unknown task: ${task}`);
  process.exit(1);
}
