import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_LOCALES } from '@opennavo/shared';
import { toAppLocale, toRouteLocale } from '../app/utils/locale';

const messages = (file: string) =>
  JSON.parse(readFileSync(new URL(`../i18n/locales/${file}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const i18nLock = JSON.parse(readFileSync(new URL('../../../tooling/i18n/i18n.lock.json', import.meta.url), 'utf8')) as {
  targets: { web: { sources: Record<string, string> } };
};

const keys = (value: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'object' && child !== null
      ? keys(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );

describe('Locales', () => {
  it('Map i18n route codes to the ten site locales', () => {
    expect(toAppLocale('en')).toBe('en-US');
    expect(toAppLocale('zh-CN')).toBe('zh-CN');
    expect(toAppLocale('fr')).toBe('fr-FR');
    expect(toAppLocale('zh-hant')).toBe('zh-Hant');
    expect(toAppLocale('nl')).toBe('en-US');
    for (const locale of SITE_LOCALES) {
      expect(toAppLocale(toRouteLocale(locale))).toBe(locale);
      expect(toAppLocale(locale)).toBe(locale);
    }
  });

  it('Every site language has locked message keys; unlocked keys may use English fallback', () => {
    const sourceKeys = keys(messages('zh-CN'));
    const lockedKeys = new Set(Object.keys(i18nLock.targets.web.sources));
    for (const locale of SITE_LOCALES) {
      const localeKeys = keys(messages(locale));
      expect(localeKeys.filter(key => !sourceKeys.includes(key))).toEqual([]);
      expect(localeKeys.filter(key => !lockedKeys.has(key))).toEqual(
        sourceKeys.filter(key => !lockedKeys.has(key) && localeKeys.includes(key))
      );
      expect(sourceKeys.filter(key => !localeKeys.includes(key)).every(key => !lockedKeys.has(key))).toBe(true);
    }
  });
});
