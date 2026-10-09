export type PackageKind = 'cask' | 'formula';

export const PACKAGE_KINDS: readonly PackageKind[] = ['cask', 'formula'];

export function isPackageKind(value: unknown): value is PackageKind {
  return value === 'cask' || value === 'formula';
}

/** UI locales generated from the six-language manifest. */
export type { LocaleCode as Locale } from './locales.gen';
export { LOCALES } from './locales.gen';
