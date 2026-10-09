import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../node_modules/satori/package.json', import.meta.url));
const { parse } = require('@shuding/opentype.js');
for (const code of ['en-US', 'zh-CN', 'ja-JP', 'es-ES', 'pt-BR', 'ru-RU']) {
  test(`${code} share-image title, description, and footer have all glyphs at both static weights`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../i18n/locales/${code}.json`, import.meta.url), 'utf8'));
    const variant = code === 'ja-JP' ? 'jp' : 'sc';
    const text = Object.values(messages.site).join('') + (code === 'ja-JP' ? '閲覧ソフトウェアひらがなカタカナ' : '');
    for (const weight of [400, 600]) {
      const buffer = readFileSync(new URL(`../public/fonts/og-noto-sans-${variant}-${weight}.woff`, import.meta.url));
      const font = parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      for (const character of new Set(text)) {
        if (/\p{L}|\p{N}/u.test(character))
          assert.notEqual(font.charToGlyphIndex(character), 0, `${weight}: ${character}`);
      }
    }
  });
}
