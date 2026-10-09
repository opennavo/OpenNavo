import { describe, expect, it } from 'vitest';
import { ICON_PALETTE, cliAbbreviation, darken, fnv1a32, iconColor, iconInitials } from '../src/icons';

describe('fnv1a32', () => {
  it('Matches standard hash vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('Matches Rust UTF-8 hashing', () => {
    expect(fnv1a32('微信')).toBe(0xd80ad4dc);
    expect(fnv1a32('visual-studio-code')).toBe(0xec86e9ac);
  });
});

describe('iconColor', () => {
  it('Prefers a valid accent color', () => {
    expect(iconColor('ghostty', '#3c96f5')).toBe('#3C96F5');
  });

  it('Falls back to a hashed palette color', () => {
    for (const accent of [undefined, null, '', 'red', '#FFF']) {
      const picked = iconColor('ripgrep', accent);
      expect(picked).toBe(ICON_PALETTE[fnv1a32('ripgrep') % ICON_PALETTE.length]);
    }
    expect(ICON_PALETTE).toHaveLength(6);
  });
});

describe('darken', () => {
  it('Blends with black', () => {
    expect(darken('#FFFFFF')).toBe('#D1D1D1');
    expect(darken('#7B72EE', 0)).toBe('#7B72EE');
    expect(darken('#7B72EE', 1)).toBe('#000000');
  });

  it('Rejects colors other than six-digit hexadecimal values', () => {
    expect(() => darken('red')).toThrow();
  });
});

describe('iconInitials', () => {
  it.each([
    ['微信', '微'],
    ['网易云音乐', '网'],
    ['Ghostty', 'G'],
    ['Visual Studio Code', 'VS'],
    ['Google Chrome', 'GC'],
    ['iTerm2', 'I'],
    ['1Password 8', '18'],
    ['  docker-desktop ', 'DD'],
    ['···', '?'],
    ['', '?']
  ])('%s → %s', (name, expected) => {
    expect(iconInitials(name)).toBe(expected);
  });
});

describe('cliAbbreviation', () => {
  it.each([
    ['ripgrep', 'rg'],
    ['node', 'nd'],
    ['node@22', 'nd'],
    ['python@3.12', 'py'],
    ['uv', 'uv'],
    ['r', 'r'],
    ['gtk+3', 'gt'],
    ['@@', '?']
  ])('%s → %s', (token, expected) => {
    expect(cliAbbreviation(token)).toBe(expected);
  });
});
