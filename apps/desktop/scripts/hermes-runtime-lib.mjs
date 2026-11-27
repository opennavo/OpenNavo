import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RUNTIME_MANIFEST_PATH = join(desktopRoot, 'hermes', 'runtime.json');
export const RUNTIME_ROOT = join(desktopRoot, 'src-tauri', 'resources', 'hermes');

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function invalid(field, message) {
  throw new Error(`Invalid Hermes runtime manifest at ${field}: ${message}`);
}

function objectAt(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'expected an object');
  return value;
}

function stringAt(value, field, pattern) {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'expected a non-empty string');
  if (pattern && !pattern.test(value)) invalid(field, `unexpected value ${JSON.stringify(value)}`);
  return value;
}

export function validateRuntimeManifest(input) {
  const manifest = objectAt(input, '<root>');
  if (manifest.schemaVersion !== 1) invalid('schemaVersion', 'expected 1');

  const hermes = objectAt(manifest.hermes, 'hermes');
  const version = stringAt(hermes.version, 'hermes.version', VERSION_RE);
  const tag = stringAt(hermes.tag, 'hermes.tag');
  if (tag !== `v${version}`) invalid('hermes.tag', `expected v${version}`);
  stringAt(hermes.commit, 'hermes.commit', COMMIT_RE);
  if (!Number.isSafeInteger(hermes.commitTimestamp) || hermes.commitTimestamp <= 0) {
    invalid('hermes.commitTimestamp', 'expected a positive Unix timestamp');
  }

  stringAt(manifest.python, 'python', /^\d+\.\d+$/);

  const cuaDriver = objectAt(manifest.cuaDriver, 'cuaDriver');
  stringAt(cuaDriver.version, 'cuaDriver.version', VERSION_RE);

  if (!Array.isArray(manifest.plugins)) invalid('plugins', 'expected an array');
  const pluginNames = new Set();
  for (const [index, plugin] of manifest.plugins.entries()) {
    const field = `plugins[${index}]`;
    objectAt(plugin, field);
    const name = stringAt(plugin.name, `${field}.name`, /^[a-z0-9][a-z0-9-]*$/);
    if (pluginNames.has(name)) invalid(`${field}.name`, `duplicate plugin ${name}`);
    pluginNames.add(name);
    const repository = stringAt(plugin.repository, `${field}.repository`);
    if (!repository.startsWith('https://')) invalid(`${field}.repository`, 'must use HTTPS');
    stringAt(plugin.ref, `${field}.ref`, COMMIT_RE);
  }

  const release = objectAt(manifest.release, 'release');
  stringAt(release.repository, 'release.repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  if (release.tag !== `hermes-runtime-v${version}`) {
    invalid('release.tag', `expected hermes-runtime-v${version}`);
  }
  if (release.asset !== `runtime-${version}-macos-arm64.tar.gz`) {
    invalid('release.asset', `expected runtime-${version}-macos-arm64.tar.gz`);
  }
  if (typeof release.sha256 !== 'string') invalid('release.sha256', 'expected a string');
  if (release.sha256 && !SHA256_RE.test(release.sha256)) {
    invalid('release.sha256', 'expected 64 lowercase hexadecimal characters');
  }

  return manifest;
}

export function readRuntimeManifest(path = RUNTIME_MANIFEST_PATH) {
  return validateRuntimeManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeRuntimeManifest(manifest, path = RUNTIME_MANIFEST_PATH) {
  validateRuntimeManifest(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function requireReleaseChecksum(manifest) {
  if (!SHA256_RE.test(manifest.release.sha256)) {
    throw new Error(
      `Hermes runtime ${manifest.release.asset} has no pinned SHA-256. Run hermes:package and commit the updated runtime.json.`
    );
  }
  return manifest.release.sha256;
}

export function runtimeReleaseUrl(manifest) {
  return `https://github.com/${manifest.release.repository}/releases/download/${manifest.release.tag}/${manifest.release.asset}`;
}

export function runtimeSourceUrl(manifest) {
  // Address the commit, not the tag: a moved tag would otherwise build code that does not match
  // the commit recorded in install-stamp.json.
  return `https://github.com/NousResearch/hermes-agent/archive/${manifest.hermes.commit}.tar.gz`;
}

export function normalizeHermesVersion(output) {
  return /^Hermes Agent v?(\d+\.\d+\.\d+)\b/m.exec(String(output))?.[1] ?? null;
}

export function assertRuntimeVersionOutput(output, manifest) {
  const actual = normalizeHermesVersion(output);
  const expected = manifest.hermes.version;
  if (actual !== expected) {
    const firstLine = String(output).trim().split('\n')[0] || '<empty>';
    throw new Error(`Hermes runtime reports ${actual ?? 'an unknown version'}, expected ${expected}: ${firstLine}`);
  }
  return actual;
}

export function readCuaDriverVersion(appPath) {
  try {
    return execFileSync(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8' }
    ).trim();
  } catch (error) {
    throw new Error(`Could not read CuaDriver.app version at ${appPath}: ${error.message}`, { cause: error });
  }
}

export function assertCuaDriverVersion(appPath, expected) {
  if (!existsSync(join(appPath, 'Contents', 'MacOS', 'cua-driver'))) {
    throw new Error(`CuaDriver.app is missing its cua-driver executable: ${appPath}`);
  }
  const actual = readCuaDriverVersion(appPath);
  if (actual !== expected) {
    throw new Error(`CuaDriver.app is ${actual}, expected ${expected}. Set HERMES_CUA_DRIVER_APP to the pinned build.`);
  }
  return actual;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertPreparedRuntime(root, manifest, { verifyVersion = true } = {}) {
  const required = [
    'bin/hermes',
    `python/bin/python${manifest.python}`,
    'site/hermes_cli/main.py',
    'site/install-stamp.json',
    'CuaDriver.app/Contents/MacOS/cua-driver'
  ];
  for (const file of required) {
    if (!existsSync(join(root, file))) throw new Error(`Prepared Hermes runtime is missing ${file}`);
  }
  if (existsSync(join(root, 'build-home'))) {
    throw new Error('Prepared Hermes runtime still contains build-home; remove it before packaging.');
  }

  const stamp = JSON.parse(readFileSync(join(root, 'site', 'install-stamp.json'), 'utf8'));
  const expectedStamp = {
    schemaVersion: 2,
    commit: manifest.hermes.commit,
    branch: null,
    dirty: false,
    source: 'ci',
    baseVersion: manifest.hermes.version,
    displayVersion: manifest.hermes.version,
    distance: 0,
    payload: 'runtime',
    tag: manifest.hermes.tag,
    distribution: 'desktop-app',
    updateMechanism: 'external'
  };
  for (const [field, expected] of Object.entries(expectedStamp)) {
    if (stamp[field] !== expected) {
      throw new Error(
        `install-stamp.json ${field} is ${JSON.stringify(stamp[field])}, expected ${JSON.stringify(expected)}`
      );
    }
  }

  assertCuaDriverVersion(join(root, 'CuaDriver.app'), manifest.cuaDriver.version);

  for (const plugin of manifest.plugins) {
    const pluginRoot = join(root, 'plugins', plugin.name);
    if (!existsSync(join(pluginRoot, 'plugin.yaml')))
      throw new Error(`Prepared runtime is missing plugin ${plugin.name}`);
    const catalogPath = join(pluginRoot, '.hermes-catalog.json');
    if (!existsSync(catalogPath)) throw new Error(`Plugin ${plugin.name} has no .hermes-catalog.json`);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    if (catalog.sha !== plugin.ref) {
      throw new Error(`Plugin ${plugin.name} is pinned to ${catalog.sha}, expected ${plugin.ref}`);
    }
  }

  if (!verifyVersion) return null;

  const checkHome = mkdtempSync(join(tmpdir(), 'opennavo-hermes-check-'));
  try {
    const output = execFileSync(join(root, 'bin', 'hermes'), ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, HERMES_HOME: checkHome, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return assertRuntimeVersionOutput(output, manifest);
  } finally {
    rmSync(checkHome, { recursive: true, force: true });
  }
}

export function applyHermesRelease(manifest, release) {
  const next = structuredClone(validateRuntimeManifest(manifest));
  if (!VERSION_RE.test(release.version)) throw new Error(`Invalid Hermes version: ${release.version}`);
  if (release.tag !== `v${release.version}`)
    throw new Error(`Release tag ${release.tag} does not match ${release.version}`);
  if (!COMMIT_RE.test(release.commit)) throw new Error(`Invalid Hermes commit: ${release.commit}`);
  if (!Number.isSafeInteger(release.commitTimestamp) || release.commitTimestamp <= 0) {
    throw new Error('The Hermes release commit has no valid timestamp');
  }
  next.hermes.version = release.version;
  next.hermes.tag = release.tag;
  next.hermes.commit = release.commit;
  next.hermes.commitTimestamp = release.commitTimestamp;
  next.release.tag = `hermes-runtime-v${release.version}`;
  next.release.asset = `runtime-${release.version}-macos-arm64.tar.gz`;
  next.release.sha256 = '';
  return validateRuntimeManifest(next);
}

/**
 * The commit a release tag actually points at. GitHub's `target_commitish` is only a hint
 * (often a branch name) and is not sent for releases whose tag existed first, so resolve the
 * tag ref itself; an annotated tag needs one more hop to its commit object.
 */
export function resolveTagCommit(ref, annotatedTag) {
  if (!ref || typeof ref !== 'object' || !COMMIT_RE.test(ref.sha ?? '')) {
    throw new Error(`Release tag does not resolve to a commit: ${ref?.sha}`);
  }
  if (ref.type === 'tag') {
    const target = annotatedTag?.object;
    const sha = target?.sha;
    if (target?.type !== 'commit' || !COMMIT_RE.test(sha ?? '')) {
      throw new Error(`Annotated release tag ${ref.sha} does not point at a commit object: ${target?.type} ${sha}`);
    }
    return sha;
  }
  if (ref.type !== 'commit') {
    throw new Error(`Release tag points at an unsupported object type: ${ref.type}`);
  }
  return ref.sha;
}

/**
 * Decide what a prebuilt runtime source means for the output directory.
 *
 * Equal paths: validate in place. A source inside the output would be deleted before the
 * copy; an output inside the source would make the recursive copy include its own target.
 * Both are refused instead of silently removing the input.
 */
export function prebuiltCopyPlan(source, output) {
  const canonical = path => {
    // Canonicalize the nearest existing ancestor (so a symlinked /tmp still compares) and
    // append the not-yet-created suffix. One-level canonicalization missed `root/inside`
    // when `root` itself did not exist yet.
    let current = resolve(path);
    const suffix = [];
    for (;;) {
      try {
        return join(realpathSync.native(current), ...suffix);
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(path);
        suffix.unshift(basename(current));
        current = parent;
      }
    }
  };
  const src = canonical(source);
  const out = canonical(output);
  if (src === out) return 'validate';
  const inside = (child, parent) => {
    const rel = relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (inside(src, out)) {
    throw new Error(`HERMES_RUNTIME_PREBUILT is inside the output directory: ${src}`);
  }
  if (inside(out, src)) {
    throw new Error(`HERMES_RUNTIME_PREBUILT contains the output directory: ${src}`);
  }
  return 'copy';
}
