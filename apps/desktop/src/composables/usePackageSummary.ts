import type { PackageSummary } from '@opennavo/api';
import type { CategoryItem } from '@/ipc/bindings';
import type { LocalItem } from '@/ipc/client';
import { useCatalogStore } from '@/stores';
import { useAppLocale } from './useAppLocale';

/**
 * Local catalog entries → API PackageSummary: shared components such as OnAppCard and OnRankRow accept only API types.
 * Offline pages (categories, rankings, search) use the same components.
 */
export function usePackageSummary() {
  const { pick } = useAppLocale();
  const catalog = useCatalogStore();

  function primaryCategory(item: LocalItem): PackageSummary['primaryCategory'] {
    const slug = item.categories[0];
    const category = slug ? catalog.categories.find((entry: CategoryItem) => entry.slug === slug) : undefined;
    return category ? { slug: category.slug, name: category.name, icon: category.icon } : null;
  }

  function toSummary(item: LocalItem): PackageSummary {
    return {
      kind: item.kind,
      token: item.token,
      name: item.name,
      displayName: pick(item.displayName, item.name, item.sourceLocale),
      summary: pick(item.summary, '', item.sourceLocale) || null,
      iconUrl: item.iconUrl,
      accentColor: item.accentColor,
      version: item.version,
      primaryCategory: primaryCategory(item),
      installs30d: item.installs30d,
      rank30d: item.rank30d,
      autoUpdates: item.autoUpdates,
      deprecated: item.deprecated,
      disabled: item.disabled,
      isFont: item.isFont,
      isLibrary: item.isLibrary,
      editorChoice: false,
      versionChangedAt: item.versionChangedAt
    };
  }

  return { toSummary };
}
