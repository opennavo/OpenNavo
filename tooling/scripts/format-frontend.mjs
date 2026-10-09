// Resolve exclusions at the repository root, independent of the config file's directory.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
  console.error('Usage: node tooling/scripts/format-frontend.mjs [--check|--write]');
  process.exit(2);
}
const exclusions = readFileSync(new URL('../config/oxfmt.ignore', import.meta.url), 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(pattern => `!${pattern}`);
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'oxfmt',
    '--config',
    'tooling/config/.oxfmtrc.json',
    mode,
    '--no-error-on-unmatched-pattern',
    'packages',
    'apps/web',
    'apps/desktop',
    ...exclusions
  ],
  { cwd: root, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
