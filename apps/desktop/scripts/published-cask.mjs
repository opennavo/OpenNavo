// The tap accepts only official stable releases from the backend; making GitHub files public alone cannot trigger a tap update.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { githubArtifactUrl, isReleaseVersion, renderCask, channelOf } from './release-lib.mjs';
import { verifyDownload } from './github-release.mjs';

export async function publishedCask(values, fetcher = fetch) {
  if (!isReleaseVersion(values.version ?? '') || channelOf(values.version) !== 'stable')
    throw new Error('stable version required');
  for (const value of [values['api-base'], values['manifest-url']]) {
    if (new URL(value).protocol !== 'https:') throw new Error('HTTPS required');
  }
  const response = await fetcher(`${values['api-base'].replace(/\/+$/, '')}/desktop/releases/latest?channel=stable`, {
    signal: AbortSignal.timeout(30_000)
  });
  const envelope = await response.json();
  if (
    !response.ok ||
    envelope.code !== '0000' ||
    envelope.data?.version !== values.version ||
    envelope.data?.channel !== 'stable'
  ) {
    throw new Error('requested version is not the published stable release');
  }
  const manifestResponse = await fetcher(values['manifest-url'], { signal: AbortSignal.timeout(30_000) });
  const manifest = await manifestResponse.json();
  if (!manifestResponse.ok || manifest.version !== values.version) throw new Error('stable manifest does not match');
  const dmg = envelope.data.downloads.find(row => row.target === 'dmg-universal');
  const expected = githubArtifactUrl(
    values.repository ?? '',
    values.version,
    `OpenNavo_${values.version}_universal.dmg`
  );
  if (!dmg || dmg.url !== expected || !/^[a-f0-9]{64}$/.test(dmg.sha256) || dmg.bytes <= 0)
    throw new Error('invalid published DMG');
  await verifyDownload(expected, { name: 'DMG', bytes: dmg.bytes, sha256: dmg.sha256 }, fetcher);
  const template = readFileSync(
    fileURLToPath(new URL('../packaging/homebrew/opennavo.rb.tmpl', import.meta.url)),
    'utf8'
  );
  return renderCask(template, {
    version: values.version,
    sha256: dmg.sha256,
    downloadUrl: expected,
    manifestUrl: values['manifest-url'],
    homepage: values.homepage
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      repository: { type: 'string', default: process.env.GITHUB_REPOSITORY },
      'api-base': { type: 'string', default: 'https://api.opennavo.com/api/v1' },
      'manifest-url': { type: 'string', default: 'https://cdn.opennavo.com/desktop/stable/latest.json' },
      homepage: { type: 'string', default: 'https://opennavo.com/' },
      out: { type: 'string', default: 'tap/Casks/opennavo.rb' }
    }
  });
  const cask = await publishedCask(values);
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, cask);
}
