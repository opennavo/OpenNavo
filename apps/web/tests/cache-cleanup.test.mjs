import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupBuild } from '../scripts/cache-cleanup.mjs';

test('cleanup requires an explicit retired build, protects active builds and defaults to dry run', async () => {
  let deletes = [];
  const client = {
    scan: async () => [
      '0',
      ['opennavo:web:cache:old:k', 'opennavo:web:cache:old:k', 'opennavo:web:cache:new:k', 'asynq:queue']
    ],
    pipeline: () => {
      let n = 0;
      return {
        memory: () => {
          n++;
        },
        exec: async () => Array.from({ length: n }, () => [null, 100])
      };
    },
    unlink: async (...keys) => {
      deletes.push(...keys);
    }
  };
  await assert.rejects(cleanupBuild(client, { build: 'new', keep: ['new'], apply: true }));
  await assert.rejects(cleanupBuild(client, { build: '*', keep: ['new'], apply: true }));
  await assert.rejects(cleanupBuild(client, { build: 'old', keep: [], apply: true }));
  const preview = await cleanupBuild(client, { build: 'old', keep: ['new'] });
  assert.equal(preview.keys, 1);
  assert.equal(preview.approximateBytes, 100);
  assert.deepEqual(deletes, []);
  await cleanupBuild(client, { build: 'old', keep: ['new'], apply: true });
  assert.deepEqual(deletes, ['opennavo:web:cache:old:k']);
});
