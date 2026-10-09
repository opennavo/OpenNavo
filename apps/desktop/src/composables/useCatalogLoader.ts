import type { WatchSource } from 'vue';
import { useCatalogStore } from '@/stores/catalog';
import { useNamesStore } from '@/stores/names';
import type { LocalItem } from '@/ipc/client';
import { useLoader } from './useLoader';

/** Reread the local catalog after sync, even when language-pack updates leave the catalog cursor unchanged. */
export function useCatalogLoader<T>(
  fetcher: () => Promise<T>,
  sources: WatchSource[],
  itemsOf: (value: T) => readonly LocalItem[]
) {
  const catalog = useCatalogStore();
  const names = useNamesStore();
  return useLoader(fetcher, [...sources, () => catalog.revision], value => names.remember(itemsOf(value)), sources);
}
