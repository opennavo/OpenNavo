// Run shared checks from the repository root so relocated ignore patterns keep their meaning.
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = relative(root, process.cwd()) || '.';
const checks = [
  ['oxlint', '--config', 'tooling/config/.oxlintrc.json', '--ignore-path', 'tooling/config/oxlint.ignore', target]
];
if (process.argv.includes('--eslint')) checks.push(['eslint', '--config', 'tooling/config/eslint.config.mjs', target]);
for (const args of checks) {
  const result = spawnSync('pnpm', ['exec', ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
