import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
mkdirSync('node_modules/.cache', { recursive: true });
test('Copy checks reject static text and attributes but allow dynamic copy, brands, developer errors, and comments', () => {
  const directory = mkdtempSync(resolve('node_modules/.cache/i18n-lint-'));
  const file = resolve(directory, 'fixture.vue');
  const run = source => {
    writeFileSync(file, source);
    return spawnSync(process.execPath, ['tooling/scripts/check-hardcoded-i18n.mjs', directory], { encoding: 'utf8' });
  };
  try {
    for (const source of [
      '<template><p>Hello world</p></template>',
      '<template><input placeholder="Search apps" /></template>',
      '<template><p v-if="visible">日本語の説明</p></template>',
      '<script setup lang="ts">const title = "写死文案";</script><template><p>{{ title }}</p></template>'
    ])
      assert.equal(run(source).status, 1);
    assert.equal(
      run(
        '<script setup lang="ts">// 中文注释\nthrow new Error("开发者错误"); console.log("调试");</script><template><p>OpenNavo</p><p>{{ t("search.title") }}</p><input :placeholder="t(\'search.placeholder\')" /></template>'
      ).status,
      0
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
