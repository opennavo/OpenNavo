#!/usr/bin/env node
/**
 * Build the relocatable Hermes sidecar used by the OpenNavo desktop app.
 *
 * Everything versioned comes from apps/desktop/hermes/runtime.json. The build
 * fails unless the resulting runtime reports that exact version from an
 * isolated HERMES_HOME, carries the pinned CuaDriver, and has every pinned
 * plugin at the requested commit.
 *
 *   pnpm --filter @opennavo/desktop hermes:prepare -- --force
 *
 * CI can provide HERMES_RUNTIME_PREBUILT pointing at a previously built
 * resources/hermes directory to skip the download, but the same checks run.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  RUNTIME_ROOT,
  assertCuaDriverVersion,
  assertPreparedRuntime,
  readRuntimeManifest,
  runtimeSourceUrl
} from './hermes-runtime-lib.mjs';

const resources = RUNTIME_ROOT;
const pythonDir = join(resources, 'python');
const siteDir = join(resources, 'site');
const binDir = join(resources, 'bin');
const force = process.argv.includes('--force');
const prebuilt = process.env.HERMES_RUNTIME_PREBUILT;
const manifest = readRuntimeManifest();
const { version, tag, commit, commitTimestamp } = manifest.hermes;
const pythonVersion = manifest.python;
let buildTmp;

function run(command, args, options = {}) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function assertBuildHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The Hermes runtime is a macOS arm64 artifact and must be built on Apple Silicon.');
  }
}

function uvPath() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return 'uv';
  } catch {
    throw new Error('uv is required to build the Hermes runtime (brew install uv).');
  }
}

function installRuntime() {
  if (prebuilt) {
    const source = resolve(prebuilt);
    if (!existsSync(join(source, 'bin', 'hermes'))) {
      throw new Error(`HERMES_RUNTIME_PREBUILT is not a Hermes runtime: ${source}`);
    }
    rmSync(resources, { recursive: true, force: true });
    mkdirSync(dirname(resources), { recursive: true });
    cpSync(source, resources, { recursive: true, dereference: true });
    console.log(`Copied prebuilt Hermes runtime from ${source}`);
    return;
  }

  if (!force && existsSync(join(siteDir, 'hermes_cli', 'main.py'))) {
    const cuaApp = process.env.HERMES_CUA_DRIVER_APP || '/Applications/CuaDriver.app';
    if (!existsSync(join(resources, 'CuaDriver.app')) && existsSync(cuaApp)) {
      assertCuaDriverVersion(cuaApp, manifest.cuaDriver.version);
      cpSync(cuaApp, join(resources, 'CuaDriver.app'), { recursive: true, dereference: true });
      console.log('Added CuaDriver.app to the existing Hermes runtime.');
    }
    console.log('Hermes runtime already exists; validating it. Pass --force to rebuild.');
    return;
  }

  const uv = uvPath();
  rmSync(resources, { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  run(uv, ['python', 'install', pythonVersion]);
  const python = execFileSync(uv, ['python', 'find', pythonVersion], { encoding: 'utf8' }).trim();
  if (!python || !existsSync(python)) throw new Error(`uv did not return a Python ${pythonVersion} interpreter`);

  console.log(`\nCopying standalone Python from ${python}`);
  cpSync(dirname(dirname(python)), pythonDir, { recursive: true, dereference: true });

  // 0.23+ is not on PyPI. Build from the tagged source with the repository's
  // uv.lock so provider plugins and exact pins stay consistent.
  // Build outside the repository: write_install_stamp.py walks up looking for
  // .git and would otherwise stamp this worktree's branch/dirty state into the
  // sealed upstream identity.
  buildTmp = mkdtempSync(join(tmpdir(), `opennavo-hermes-${version}-`));
  const tmp = buildTmp;
  const tarball = join(tmp, `hermes-${version}.tar.gz`);
  run('curl', ['-sSL', '--fail', runtimeSourceUrl(manifest), '-o', tarball]);
  run('tar', ['-xzf', tarball, '-C', tmp]);
  const source = join(tmp, `hermes-agent-${version}`);
  const venv = join(tmp, 'venv');
  run(uv, ['sync', '--frozen', '--python', join(pythonDir, 'bin', `python${pythonVersion}`)], {
    cwd: source,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv }
  });
  run(
    uv,
    [
      'pip',
      'install',
      '--python',
      join(venv, 'bin', `python${pythonVersion}`),
      '--no-deps',
      '--force-reinstall',
      source
    ],
    {
      cwd: source,
      env: { ...process.env, HERMES_NIX_BUILD: '1' }
    }
  );
  const sitePackages = join(venv, 'lib', `python${pythonVersion}`, 'site-packages');
  cpSync(sitePackages, siteDir, { recursive: true, dereference: true });
  cpSync(join(source, 'uv.lock'), join(siteDir, 'uv.lock'));
  rmSync(join(siteDir, '__editable__hermes_agent-0.0.0.pth'), { force: true });
  rmSync(join(siteDir, '__editable___hermes_agent_0_0_0_finder.py'), { force: true });

  const wrapper = `#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PYTHONPATH="$DIR/site\${PYTHONPATH:+:$PYTHONPATH}"
exec "$DIR/python/bin/python${pythonVersion}" -c 'from hermes_cli.main import main; main()' "$@"
`;
  writeFileSync(join(binDir, 'hermes'), wrapper, { mode: 0o755 });
  chmodSync(join(binDir, 'hermes'), 0o755);

  // The OpenNavo runtime bundles a sealed upstream identity. Without this
  // stamp, a clean HERMES_HOME reports "unknown" even though the source tag
  // is correct.
  run(
    join(venv, 'bin', `python${pythonVersion}`),
    [
      join(source, 'scripts', 'write_install_stamp.py'),
      '--output',
      join(siteDir, 'install-stamp.json'),
      '--commit',
      commit,
      '--base-version',
      version,
      '--distance',
      '0',
      '--commit-date',
      String(commitTimestamp),
      '--source',
      'ci',
      '--distribution',
      'desktop-app',
      '--update-mechanism',
      'external'
    ],
    {
      cwd: source,
      env: {
        ...process.env,
        HERMES_DESKTOP_VARIANT: 'runtime',
        HERMES_PAYLOAD_TAG: tag
      }
    }
  );

  const cuaApp = process.env.HERMES_CUA_DRIVER_APP || '/Applications/CuaDriver.app';
  if (!existsSync(cuaApp)) {
    throw new Error(
      `CuaDriver.app was not found at ${cuaApp}. Install the pinned CuaDriver or set HERMES_CUA_DRIVER_APP.`
    );
  }
  assertCuaDriverVersion(cuaApp, manifest.cuaDriver.version);
  cpSync(cuaApp, join(resources, 'CuaDriver.app'), { recursive: true, dereference: true });
  console.log('Bundled CuaDriver.app; grant Accessibility and Screen Recording on first use.');

  // Provider plugins are part of the runtime contract. An install failure
  // must fail the build: publishing a runtime without Copilot is worse than
  // stopping the release.
  const buildHome = join(resources, 'build-home');
  try {
    for (const plugin of manifest.plugins) {
      run(
        join(binDir, 'hermes'),
        ['plugins', 'install', plugin.name, '--ref', plugin.ref, '--yes-deps', '--no-enable'],
        {
          cwd: resources,
          env: { ...process.env, HERMES_HOME: buildHome }
        }
      );
      const bundledPlugin = join(buildHome, 'plugins', plugin.name);
      const catalogPath = join(bundledPlugin, '.hermes-catalog.json');
      if (!existsSync(join(bundledPlugin, 'plugin.yaml')) || !existsSync(catalogPath)) {
        throw new Error(`Hermes did not install plugin ${plugin.name} into the build home`);
      }
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
      if (catalog.sha !== plugin.ref) {
        throw new Error(`Plugin ${plugin.name} installed ${catalog.sha}, expected ${plugin.ref}`);
      }
      mkdirSync(join(resources, 'plugins'), { recursive: true });
      cpSync(bundledPlugin, join(resources, 'plugins', plugin.name), { recursive: true, dereference: true });
    }
  } finally {
    rmSync(buildHome, { recursive: true, force: true });
  }

  writeFileSync(
    join(resources, 'manifest.json'),
    `${JSON.stringify(
      {
        hermesAgent: version,
        hermesCommit: commit,
        python: pythonVersion,
        cuaDriver: manifest.cuaDriver.version,
        plugins: manifest.plugins,
        builtAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
  console.log(`\nHermes runtime ready at ${resources}`);
}

try {
  assertBuildHost();
  installRuntime();
  const runtimeVersion = assertPreparedRuntime(resources, manifest);
  console.log(`\nVerified Hermes runtime ${runtimeVersion} in an isolated HERMES_HOME.`);
} catch (error) {
  console.error(`Hermes runtime preparation failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (buildTmp) rmSync(buildTmp, { recursive: true, force: true });
}
