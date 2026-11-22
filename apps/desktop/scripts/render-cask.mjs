// Render the project's tap cask (06 §15): use version and Universal DMG SHA-256 from release-artifacts.mjs's dmg-universal.json.
// Usage: node apps/desktop/scripts/render-cask.mjs --dir release-artifacts --version 0.3.0 --homepage https://… --out Casks/opennavo.rb
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { githubArtifactUrl, renderCask } from './release-lib.mjs';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'release-artifacts' },
    version: { type: 'string' },
    repository: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'opennavo/OpenNavo' },
    homepage: { type: 'string', default: 'https://opennavo.com/' },
    out: { type: 'string', default: 'Casks/opennavo.rb' }
  }
});
const version = values.version ?? '';
const dmg = JSON.parse(readFileSync(join(resolve(values.dir), 'dmg-universal.json'), 'utf8'));
const repository = values.repository || process.env.GITHUB_REPOSITORY || 'opennavo/OpenNavo';
const downloadUrl = githubArtifactUrl(repository, version, `OpenNavo_${version}_universal.dmg`);
if (dmg.url !== downloadUrl) throw new Error('dmg-universal.json url does not match the GitHub release asset');
const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../packaging/homebrew/opennavo.rb.tmpl'),
  'utf8'
);
const cask = renderCask(template, {
  version,
  sha256: dmg.sha256,
  downloadUrl: dmg.url,
  repository,
  homepage: values.homepage
});
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, cask);
console.log(`rendered ${out}`);
