import type { QueryOf } from '@/typings/api/opennavo';

type Query = QueryOf<'listAdminPackages'>;

/** Filters: tristate strings (yes/no/any) converted to booleans for requests. Cask-only catalog (ADR-018) fixes kind to cask. */
export interface PackageFilters {
  q: string;
  kind: Query['kind'] | null;
  categoryId: number | null;
  translationStatus: Query['translationStatus'] | null;
  sort: NonNullable<Query['sort']>;
  hasIcon: string | null;
  hidden: string | null;
  editorChoice: string | null;
  deprecated: string | null;
  disabled: string | null;
  isFont: string | null;
  isLibrary: string | null;
}

export function createFilters(): PackageFilters {
  return {
    q: '',
    kind: 'cask',
    categoryId: null,
    translationStatus: null,
    sort: 'popular',
    hasIcon: null,
    hidden: null,
    editorChoice: null,
    deprecated: null,
    disabled: null,
    isFont: null,
    isLibrary: null
  };
}
