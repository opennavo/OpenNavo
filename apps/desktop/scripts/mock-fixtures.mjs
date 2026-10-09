// Use backend desktop-sync fixtures (apps/server/testdata/desktop/catalog.json.gz: 40 seed-e2e apps and 20 categories after switching to Cask-only).
// Generate the local catalog for browser mode and component tests. After fixture changes, run `pnpm --filter @opennavo/desktop gen:mock` and commit the output.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const source = new URL('../../../apps/server/testdata/desktop/catalog.json.gz', import.meta.url);
const snapshot = JSON.parse(gunzipSync(readFileSync(source)).toString('utf8'));
const output = new URL('../src/ipc/mock-data/catalog.json', import.meta.url);

writeFileSync(
  output,
  `${JSON.stringify({ cursor: snapshot.cursor, categories: snapshot.categories, items: snapshot.items }, null, 2)}\n`
);
console.log(
  `Mock catalog: ${snapshot.items.length} packages, ${snapshot.categories.length} categories → ${output.pathname}`
);
