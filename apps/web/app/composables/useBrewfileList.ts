import type { PackageKind } from '@opennavo/shared';
import { BREWFILE_KEY, addToBrewfileList, parseBrewfileList, removeFromBrewfileList } from '~/utils/brewfileList';
import type { AddResult, BrewfileListItem } from '~/utils/brewfileList';

/**
 * Globally shared Brewfile list: read localStorage only after mounting because SSR renders an empty list.
 * Reading before hydration would make Already in list disagree with server HTML.
 */
export function useBrewfileList() {
  const items = useState<BrewfileListItem[]>('brewfile:list', () => []);
  const loaded = useState('brewfile:loaded', () => false);

  onMounted(() => {
    if (loaded.value) return;
    items.value = parseBrewfileList(localStorage.getItem(BREWFILE_KEY));
    loaded.value = true;
  });

  function save(next: BrewfileListItem[]) {
    items.value = next;
    if (import.meta.client) localStorage.setItem(BREWFILE_KEY, JSON.stringify(next));
  }

  function has(kind: PackageKind, token: string): boolean {
    return items.value.some(item => item.kind === kind && item.token === token);
  }

  function add(kind: PackageKind, token: string): AddResult {
    const { list, result } = addToBrewfileList(items.value, kind, token, new Date());
    if (result === 'added') save(list);
    return result;
  }

  function remove(kind: PackageKind, token: string) {
    save(removeFromBrewfileList(items.value, kind, token));
  }

  function move(from: number, to: number) {
    save(moveInBrewfileList(items.value, from, to));
  }

  return {
    items: readonly(items),
    count: computed(() => items.value.length),
    loaded: readonly(loaded),
    has,
    add,
    remove,
    move
  };
}
