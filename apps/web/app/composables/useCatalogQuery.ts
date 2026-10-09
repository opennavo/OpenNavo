import { CATALOG_SORTS, mergeQuery } from '~/utils/catalogQuery';

/**
 * Read/write current route query parameters; omit defaults from URLs, reset page to one when filters change.
 */
export function useCatalogQuery(defaults: Record<string, string | number | boolean>) {
  const route = useRoute();
  const router = useRouter();

  function hrefWith(patch: Record<string, string | number | boolean | undefined>): string {
    return router.resolve({ path: route.path, query: mergeQuery(route.query, patch, defaults) }).fullPath;
  }

  function update(patch: Record<string, string | number | boolean | undefined>) {
    void navigateTo(hrefWith({ page: undefined, ...patch }));
  }

  return { query: computed(() => route.query), hrefWith, update };
}

/** Sort segment options: popular / recently updated / name. */
export function useCatalogSorts() {
  const { t } = useI18n();
  const labels = { popular: 'catalog.sortPopular', updated: 'catalog.sortUpdated', name: 'catalog.sortName' } as const;
  return computed(() => CATALOG_SORTS.map(value => ({ value, label: t(labels[value]) })));
}
