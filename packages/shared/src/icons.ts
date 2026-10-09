// App icon fallbacks (08 §8.10): letter/terminal tile colors and text; shared FNV-1a 32-bit hashing, including Rust.
import { color } from '@opennavo/tokens';

/** Ordered tile palette, without synthesizing new colors: chart.series1/2/3, status.info, brand.salmon, status.success. */
export const ICON_PALETTE: readonly string[] = [
  color.chart.series1,
  color.chart.series2,
  color.chart.series3,
  color.status.info,
  color.brand.salmon,
  color.status.success
];

/** FNV-1a 32-bit hash over UTF-8 bytes, returning an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Tile accent: valid package accentColor, otherwise token-hashed palette color. */
export function iconColor(token: string, accent?: string | null): string {
  if (accent && HEX_COLOR.test(accent)) return accent.toUpperCase();
  return ICON_PALETTE[fnv1a32(token) % ICON_PALETTE.length] as string;
}

/** Darken by blending with black, used at 18% for letter-tile gradient endpoints. */
export function darken(hex: string, amount = 0.18): string {
  if (!HEX_COLOR.test(hex)) throw new Error(`Only six-digit hexadecimal colors are supported: ${hex}`);
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return `#${channels
    .map(channel =>
      Math.round(channel * (1 - amount))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase()}`;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Letter tiles: first Chinese character; uppercase first initial for one English word, first two initials for multiple words. */
export function iconInitials(name: string): string {
  const text = name.trim();
  const first = Array.from(text)[0] ?? '';
  if (CJK.test(first)) return first;
  const words = text.split(/[\s\-_.·]+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  // After filtering, each word contains letters/digits; take the first.
  const initials = words.slice(0, 2).map(word =>
    word
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .charAt(0)
      .toUpperCase()
  );
  return initials.join('') || '?';
}

// Conventional command-line abbreviations not derivable from the first two letters.
const CLI_ABBREVIATIONS: Record<string, string> = {
  ripgrep: 'rg',
  node: 'nd',
  neovim: 'nv',
  postgresql: 'pg',
  imagemagick: 'im'
};

/** Terminal tile text: remove @version, then take two alphanumeric characters; conventional overrides include ripgrep→rg and node→nd. */
export function cliAbbreviation(token: string): string {
  const base = token.replace(/@.*$/, '');
  const known = CLI_ABBREVIATIONS[base];
  if (known) return known;
  const letters = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  return letters.slice(0, 2) || '?';
}
