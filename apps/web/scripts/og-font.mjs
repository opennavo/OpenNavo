// Generate Chinese share-image font subsets (05 §6.3): Satori supports neither variable fonts nor WOFF2,
// so instantiate Noto Sans SC at 400 for summaries and 600 for headings, outputting WOFF.
// Character set: ASCII/Latin extensions, common symbols/Chinese punctuation, and all 6,763 GB2312 ideographs.
// The 3,755 level-one characters are insufficient; common characters such as the first character of Browse are level two.
// Run pnpm --filter @opennavo/web gen:og-font (downloads source fonts; commit generated output).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import subsetFont from 'subset-font';

// Pin the Google Fonts repository commit for reproducibility.
const REPO = 'https://raw.githubusercontent.com/google/fonts/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc';
// Subsets are modified OFL versions; distribute the original license alongside them.
const WEIGHTS = [400, 600];

function gb2312Hanzi() {
  const decoder = new TextDecoder('gbk');
  const chars = [];
  // Level one B0A1–D7F9, level two D8A1–F7FE; D7FA–D7FE are unused.
  for (let high = 0xb0; high <= 0xf7; high += 1) {
    for (let low = 0xa1; low <= 0xfe; low += 1) {
      if (high === 0xd7 && low > 0xf9) break;
      chars.push(decoder.decode(new Uint8Array([high, low])));
    }
  }
  return chars.join('');
}

const range = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, index) => String.fromCodePoint(from + index)).join('');

// The subset tool ignores characters absent from the source font.
const text = [
  range(0x20, 0x7e), // ASCII
  range(0xa0, 0x17f), // Latin supplement/Extended-A for names such as Café and Pixelmator.
  range(0x400, 0x52f), // Cyrillic characters.
  range(0x2010, 0x2027), // Hyphens, dashes, quotes, ellipsis.
  '←↑→↓×÷±°™®©€£¥',
  range(0x3000, 0x3011), // Chinese punctuation and brackets.
  '〔〕〖〗',
  range(0xff01, 0xff5e), // Full-width ASCII.
  gb2312Hanzi()
].join('');

function jisCharacters() {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const chars = new Set();
  for (const high of [
    ...Array.from({ length: 31 }, (_, i) => 0x81 + i),
    ...Array.from({ length: 16 }, (_, i) => 0xe0 + i)
  ]) {
    for (let low = 0x40; low <= 0xfc; low += 1) {
      if (low === 0x7f) continue;
      try {
        chars.add(decoder.decode(new Uint8Array([high, low])));
      } catch {
        /* Exclude unused JIS code points from the subset. */
      }
    }
  }
  return [...chars].join('');
}

for (const variant of ['sc', 'jp']) {
  const repo = REPO.replace('notosanssc', `notosans${variant}`);
  const name = variant === 'jp' ? 'JP' : 'SC';
  const cache = new URL(`../node_modules/.cache/og-font/NotoSans${name}-wght.ttf`, import.meta.url);
  await mkdir(new URL('.', cache), { recursive: true });
  if (!existsSync(cache)) {
    const response = await fetch(`${repo}/NotoSans${name}%5Bwght%5D.ttf`);
    if (!response.ok) throw new Error(`Failed to download source font: ${response.status}`);
    await writeFile(cache, Buffer.from(await response.arrayBuffer()));
  }
  const source = await readFile(cache);
  const characters = variant === 'jp' ? text + range(0x3040, 0x30ff) + jisCharacters() : text;
  for (const weight of WEIGHTS) {
    const target = new URL(`../public/fonts/og-noto-sans-${variant}-${weight}.woff`, import.meta.url);
    const subset = await subsetFont(source, characters, { targetFormat: 'woff', variationAxes: { wght: weight } });
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, subset);
    console.log(`Font subset ${name} ${weight}: ${(subset.length / 1024).toFixed(0)} KB`);
  }
  const licensePath = new URL(`../public/fonts/${variant === 'sc' ? 'OFL' : 'OFL-NotoSansJP'}.txt`, import.meta.url);
  if (!existsSync(licensePath)) {
    const license = await fetch(`${repo}/OFL.txt`);
    if (!license.ok) throw new Error(`Failed to download license: ${license.status}`);
    await writeFile(licensePath, await license.text());
  }
}
