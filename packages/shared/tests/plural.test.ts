import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_METADATA } from '../src/locales.gen';
import { pluralIndex, pluralRules, selectPlural } from '../src/plural';
import { interpolatePlural } from '../src/messages';

describe('Supports plural forms in all six languages', () => {
  const counts = [0, 1, 2, 5, 21];
  const expected = {
    'en-US': [1, 0, 1, 1, 1],
    'zh-CN': [0, 0, 0, 0, 0],
    'ja-JP': [0, 0, 0, 0, 0],
    'es-ES': [1, 0, 1, 1, 1],
    'pt-BR': [0, 0, 1, 1, 1],
    'ru-RU': [2, 0, 1, 2, 0]
  };

  it.each(LOCALES)('%s × 0/1/2/5/21', locale => {
    counts.forEach((count, i) => {
      expect(pluralIndex(count, locale)).toBe(expected[locale][i]);
      const forms = LOCALE_METADATA[locale].pluralCategories.join(' | ');
      expect(selectPlural(forms, count, locale)).toBe(LOCALE_METADATA[locale].pluralCategories[expected[locale][i]!]);
      expect(pluralRules[locale]!(count, LOCALE_METADATA[locale].pluralCategories.length)).toBe(expected[locale][i]);
      const route = LOCALE_METADATA[locale].prefix.slice(1) || 'en';
      expect(pluralRules[route]!(count, 1)).toBe(0);
    });
  });

  it('Falls back to other for undeclared CLDR forms, including Russian decimals', () => {
    expect(pluralIndex(1_000_000, 'es-ES')).toBe(1);
    expect(pluralIndex(1_000_000, 'pt-BR')).toBe(1);
    expect(pluralIndex(1.5, 'ru-RU')).toBe(3);
  });

  it('Selects forms and handles interpolation fallbacks', () => {
    expect(interpolatePlural('{count} update | {count} updates', { count: 1 }, 1, 'en-US')).toBe('1 update');
    expect(interpolatePlural('{count} update | {count} updates', { count: 21 }, 21, 'en-US')).toBe('21 updates');
    expect(selectPlural('unchanged', 21, 'zh-CN')).toBe('unchanged');
    expect(selectPlural('one | other', 5, 'ru-RU')).toBe('other');
  });

  it('Matches vue-i18n for separators without spaces', () => {
    expect(interpolatePlural('{count} item|{count} items', { count: 2 }, 2, 'en-US')).toBe('2 items');
    expect(selectPlural('one|few|many|other', 2, 'ru-RU')).toBe('few');
    expect(selectPlural('one|few|many|other', 5, 'ru-RU')).toBe('many');
    expect(selectPlural('one|few|many|other', 1.5, 'ru-RU')).toBe('other');
  });
});
