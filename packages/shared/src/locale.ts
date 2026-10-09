import { DEFAULT_LOCALE, LOCALES } from './locales.gen';
import type { LocaleCode } from './locales.gen';

/** Match preferences in order, mapping regional variants to supported languages and falling back to English. */
export function matchLocale(languages: readonly string[]): LocaleCode {
  for (const language of languages) {
    const normalized = language.trim().replaceAll('_', '-').toLowerCase();
    const exact = LOCALES.find(code => code.toLowerCase() === normalized);
    if (exact) return exact;
    const base = normalized.split('-')[0];
    const matched = LOCALES.find(code => code.split('-')[0] === base);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

/** Sparse content: requested locale → English → source locale, then host fallback such as official name. */
export function pick(
  text: Partial<Record<LocaleCode, string | null>> | null | undefined,
  locale: LocaleCode,
  sourceLocale: LocaleCode = DEFAULT_LOCALE,
  fallback = ''
): string {
  for (const code of [locale, DEFAULT_LOCALE, sourceLocale]) {
    const value = text?.[code];
    if (value?.trim()) return value;
  }
  return fallback;
}
