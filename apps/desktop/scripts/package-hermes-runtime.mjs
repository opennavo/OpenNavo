#!/usr/bin/env node
/** Package the prepared runtime and pin its SHA-256 in runtime.json. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_ROOT,
  assertPreparedRuntime,
  readRuntimeManifest,
  sha256File,
  writeRuntimeManifest
} from './hermes-runtime-lib.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(desktop, 'hermes-dist');

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The Hermes runtime package is macOS arm64 and must be built on Apple Silicon.');
  }
  if (!existsSync(join(RUNTIME_ROOT, 'bin', 'hermes'))) {
    throw new Error('Runtime is not prepared. Run hermes:prepare first.');
  }

  const manifest = readRuntimeManifest();
  const version = assertPreparedRuntime(RUNTIME_ROOT, manifest);
  const output = join(outputDir, manifest.release.asset);
  mkdirSync(outputDir, { recursive: true });
  execFileSync('tar', ['-czf', output, '-C', RUNTIME_ROOT, '.'], { stdio: 'inherit' });
  const digest = sha256File(output);
  writeFileSync(`${output}.sha256`, `${digest}  ${manifest.release.asset}\n`);

  manifest.release.sha256 = digest;
  writeRuntimeManifest(manifest);

  console.log(output);
  console.log(`sha256 ${digest}`);
  console.log(`Verified ${version}; pinned ${manifest.release.asset} in apps/desktop/hermes/runtime.json.`);
} catch (error) {
  console.error(`Hermes runtime packaging failed: ${error.message}`);
  process.exitCode = 1;
}
