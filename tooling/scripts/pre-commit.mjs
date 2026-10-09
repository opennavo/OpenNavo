import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

execFileSync('node', ['tooling/scripts/check-secrets.mjs'], { stdio: 'inherit' });
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const goFiles = files.filter(path => path.endsWith('.go') && existsSync(path));
if (goFiles.length) {
  const changes = execFileSync('gofmt', ['-l', ...goFiles], { encoding: 'utf8' });
  if (changes) { console.error(`Run gofmt before committing:\n${changes}`); process.exit(1); }
}
