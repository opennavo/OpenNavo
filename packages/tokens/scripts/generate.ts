// Read tokens.json and generate four dist artifacts (08 §7).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildArtifacts } from '../src/build.ts';
import type { JsonObject } from '../src/build.ts';

const root = new URL('..', import.meta.url);
const source = JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8')) as JsonObject;
const dist = new URL('dist/', root);

mkdirSync(dist, { recursive: true });
for (const [file, content] of Object.entries(buildArtifacts(source))) {
  writeFileSync(new URL(file, dist), content);
  console.log(`dist/${file}`);
}
