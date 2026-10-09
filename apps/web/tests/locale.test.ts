import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@opennavo/shared';
import { toAppLocale, toRouteLocale } from '../app/utils/locale';

const messages = (file: string) =>
  JSON.parse(readFileSync(new URL(`../i18n/locales/${file}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

const keys = (value: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'object' && child !== null
      ? keys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );

describe('Locales', () => {
  it('Map i18n route codes to six API locales', () => {
    expect(toAppLocale('en')).toBe('en-US');
    expect(toAppLocale('zh-CN')).toBe('zh-CN');
    expect(toAppLocale('fr')).toBe('en-US');
    for (const locale of LOCALES) {
      expect(toAppLocale(toRouteLocale(locale))).toBe(locale);
      expect(toAppLocale(locale)).toBe(locale);
    }
  });

  it('Six message sets have identical keys', () => {
    for (const locale of LOCALES) expect(keys(messages(locale)).sort()).toEqual(keys(messages('zh-CN')).sort());
  });
});
