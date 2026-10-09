import { LOCALES, LOCALE_METADATA, DEFAULT_LOCALE } from '@opennavo/shared';
import type { Locale } from '@opennavo/shared';

/** Map Nuxt route codes and API locales through the shared manifest. */
export function toAppLocale(code: string): Locale {
  return (
    LOCALES.find(locale => locale === code || (LOCALE_METADATA[locale].prefix.slice(1) || 'en') === code) ??
    DEFAULT_LOCALE
  );
}

type StripPrefix<T extends string> = T extends `/${infer Prefix}` ? Prefix : 'en';
type RouteLocale = StripPrefix<(typeof LOCALE_METADATA)[Locale]['prefix']>;

export function toRouteLocale(locale: Locale): RouteLocale {
  return (LOCALE_METADATA[locale].prefix.slice(1) || 'en') as RouteLocale;
}
