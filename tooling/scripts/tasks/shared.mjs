// Shared helpers for frontend and backend tasks.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

/** Run a command and propagate a nonzero exit status. */
export function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Parse a dotenv file, returning an empty object when it does not exist. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Explicit environment > local configuration > nonempty example defaults. */
export function developmentEnvironment(root = process.cwd(), environment = process.env) {
  const defaults = Object.fromEntries(
    Object.entries(readEnvFile(join(root, 'apps/server/.env.example'))).filter(([, value]) => value !== '')
  );
  return { ...defaults, ...readEnvFile(join(root, 'apps/server/.env.local')), ...environment };
}
