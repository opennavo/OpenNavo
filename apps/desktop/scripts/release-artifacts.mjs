// Collect one tauri build's artifacts (06 §15): assign stable filenames, calculate sizes and SHA-256, and read update signatures.
// Write {target}.json for register-release.mjs to merge. Missing .sig means an empty signature (allowed for drafts; required before publication).
// Usage: node apps/desktop/scripts/release-artifacts.mjs --target darwin-aarch64 --version 0.3.0 --repository OWNER/REPO --out release-artifacts
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TARGETS, artifactUrl, githubArtifactUrl, describeFile, isReleaseVersion } from './release-lib.mjs';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    'base-url': { type: 'string' },
    repository: { type: 'string' },
    'bundle-dir': { type: 'string' },
    out: { type: 'string', default: 'release-artifacts' }
  }
});
const spec = TARGETS[values.target ?? ''];
if (!spec) throw new Error(`unknown target: ${values.target}`);
if (!isReleaseVersion(values.version ?? '')) throw new Error(`invalid version: ${values.version}`);
const version = values.version;
const bundle = resolve(values['bundle-dir'] ?? `apps/desktop/src-tauri/target/${spec.rustTarget}/release/bundle`);

const folder = join(bundle, spec.bundle === 'dmg' ? 'dmg' : 'macos');
const suffix = spec.bundle === 'dmg' ? '.dmg' : '.app.tar.gz';
const found = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith(suffix)) : [];
if (found.length !== 1) throw new Error(`expected one ${suffix} in ${folder}, found ${found.length}`);
const source = join(folder, found[0]);

const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const file = spec.file(version);
copyFileSync(source, join(out, file));
const signaturePath = `${source}.sig`;
const signature =
  spec.bundle === 'app' && existsSync(signaturePath) ? readFileSync(signaturePath, 'utf8').trim() : null;
if (signature) writeFileSync(join(out, `${file}.sig`), `${signature}\n`);
if (spec.bundle === 'app' && !signature) console.warn(`::warning::${file} has no updater signature (H-07)`);

const manifest = {
  target: values.target,
  file,
  url: values['base-url']
    ? artifactUrl(values['base-url'], version, file)
    : githubArtifactUrl(values.repository ?? process.env.GITHUB_REPOSITORY ?? '', version, file),
  signature,
  ...describeFile(join(out, file))
};
writeFileSync(join(out, `${values.target}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${file}: ${manifest.bytes} bytes, sha256 ${manifest.sha256}`);
