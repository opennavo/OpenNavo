import { LOCALES, matchLocale } from '@opennavo/shared';
import type { Locale } from '@opennavo/shared';

/** Accept only supported persisted selections; rematch invalid old values against browser preferences. */
export function resolveLocale(saved: string | null | undefined, languages: readonly string[]): Locale {
  return LOCALES.find(code => code === saved) ?? matchLocale(languages);
}
