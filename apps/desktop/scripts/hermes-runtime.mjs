#!/usr/bin/env node
/** Check upstream Hermes releases or move the pinned runtime manifest to a stable release. */
import { parseArgs } from 'node:util';
import {
  RUNTIME_MANIFEST_PATH,
  applyHermesRelease,
  readRuntimeManifest,
  runtimeReleaseUrl,
  writeRuntimeManifest
} from './hermes-runtime-lib.mjs';

const RELEASES_API = 'https://api.github.com/repos/NousResearch/hermes-agent/releases';

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenNavo-Hermes-runtime-pin'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getJson(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function releaseFor(version) {
  const release = version ? await getJson(`${RELEASES_API}/tags/v${version}`) : await getJson(`${RELEASES_API}/latest`);
  if (release.draft || release.prerelease) throw new Error(`Hermes ${release.tag_name} is not a stable release`);
  const resolved = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
  if (!resolved) throw new Error(`Hermes release tag is not stable SemVer: ${release.tag_name}`);
  const commit = release.target_commitish;
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error(`Hermes ${release.tag_name} does not point at an immutable commit: ${commit}`);
  }
  const detail = await getJson(`https://api.github.com/repos/NousResearch/hermes-agent/commits/${commit}`);
  const commitTimestamp = Math.floor(new Date(detail.commit.committer.date).getTime() / 1000);
  if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp <= 0) {
    throw new Error(`Hermes ${release.tag_name} commit has no valid timestamp`);
  }
  return { version: resolved[1], tag: release.tag_name, commit, commitTimestamp, url: release.html_url };
}

function describe(manifest) {
  console.log(`Pinned Hermes: ${manifest.hermes.version} (${manifest.hermes.commit.slice(0, 12)})`);
  console.log(`Runtime asset: ${manifest.release.asset}`);
  console.log(`Download: ${runtimeReleaseUrl(manifest)}`);
  console.log(`Checksum: ${manifest.release.sha256 || 'not packaged yet'}`);
}

async function check() {
  const manifest = readRuntimeManifest();
  const latest = await releaseFor();
  describe(manifest);
  console.log(`Latest stable Hermes: ${latest.version} (${latest.commit.slice(0, 12)})`);
  if (latest.version === manifest.hermes.version) {
    console.log('Runtime pin is current.');
    return;
  }
  console.log(
    `Runtime pin is behind. Next: pnpm --filter @opennavo/desktop hermes:bump -- --version ${latest.version}`
  );
}

async function bump() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      'cua-version': { type: 'string' },
      'plugin-ref': { type: 'string' },
      python: { type: 'string' }
    },
    allowPositionals: true
  });
  if (!values.version) throw new Error('Pass --version X.Y.Z');
  const current = readRuntimeManifest();
  const release = await releaseFor(values.version);
  const next = applyHermesRelease(current, release);
  if (values['cua-version']) next.cuaDriver.version = values['cua-version'];
  if (values.python) next.python = values.python;
  if (values['plugin-ref']) {
    const plugin = next.plugins.find(item => item.name === 'github-copilot');
    if (!plugin) throw new Error('github-copilot plugin is missing from the runtime manifest');
    plugin.ref = values['plugin-ref'];
  }
  writeRuntimeManifest(next);
  console.log(`Pinned Hermes ${next.hermes.version} in ${RUNTIME_MANIFEST_PATH}`);
  console.log(`Release: ${release.url}`);
  console.log('\nNext:');
  console.log('  pnpm --filter @opennavo/desktop hermes:prepare -- --force');
  console.log('  pnpm --filter @opennavo/desktop hermes:package');
  console.log(`  Commit the runtime manifest, publish ${next.release.tag}, then release the desktop app.`);
}

const command = process.argv[2];
try {
  if (command === 'check') await check();
  else if (command === 'bump') await bump();
  else {
    console.error('Usage: hermes-runtime.mjs check | bump -- --version X.Y.Z');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
