import { describe, expect, it } from 'vitest';
import { matchLocale } from '../src/locale';
import { readFileSync } from 'node:fs';

const sharedCases: { name: string; languages: string[]; expected: string }[] = JSON.parse(
  readFileSync(new URL('../../../apps/server/testdata/locale_cases.json', import.meta.url), 'utf8')
);

describe('Locale matching', () => {
  it.each(sharedCases)('Uses the shared $name field', ({ languages, expected }) => {
    expect(matchLocale(languages)).toBe(expected);
  });
  it.each([
    [['en-US'], 'en-US'],
    [['zh-CN'], 'zh-CN'],
    [['ja-JP'], 'ja-JP'],
    [['es-ES'], 'es-ES'],
    [['pt-BR'], 'pt-BR'],
    [['ru-RU'], 'ru-RU'],
    [['fr-FR', 'JA_jp'], 'ja-JP'],
    [['zh-Hant-TW'], 'zh-CN'],
    [['pt-PT', 'en-US'], 'pt-BR'],
    [['es-MX'], 'es-ES'],
    [['en-GB'], 'en-US'],
    [['ru'], 'ru-RU'],
    [['  JA  '], 'ja-JP'],
    [[''], 'en-US'],
    [[], 'en-US']
  ])('%j → %s', (languages, expected) => expect(matchLocale(languages)).toBe(expected));
});
