// Render the project's tap cask (06 §15): use version and Universal DMG SHA-256 from release-artifacts.mjs's dmg-universal.json.
// Usage: node apps/desktop/scripts/render-cask.mjs --dir release-artifacts --version 0.3.0 --manifest-url https://… --homepage https://… --out Casks/opennavo.rb
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderCask } from './release-lib.mjs';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'release-artifacts' },
    version: { type: 'string' },
    'manifest-url': { type: 'string', default: 'https://cdn.opennavo.com/desktop/stable/latest.json' },
    homepage: { type: 'string', default: 'https://opennavo.com/' },
    out: { type: 'string', default: 'Casks/opennavo.rb' }
  }
});
const dmg = JSON.parse(readFileSync(join(resolve(values.dir), 'dmg-universal.json'), 'utf8'));
const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../packaging/homebrew/opennavo.rb.tmpl'),
  'utf8'
);
const cask = renderCask(template, {
  version: values.version ?? '',
  sha256: dmg.sha256,
  downloadUrl: dmg.url,
  manifestUrl: values['manifest-url'],
  homepage: values.homepage
});
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, cask);
console.log(`rendered ${out}`);
