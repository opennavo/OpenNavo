import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { InstalledItem, Kind, StorageSummary } from '@/ipc/bindings';
import { commands, packageKey, unwrap } from '@/ipc/client';

// Cask-only catalog (ADR-018): Homebrew command-line tools are outside OpenNavo's management scope and filtered immediately after reading.
// Sidebar counts, installed tables, and detail states all use the same list.
const onlyCasks = (list: InstalledItem[]) => list.filter(item => item.kind === 'cask');

/** Installed packages (06 §6.7): library_list immediately returns memory cache; reread on library:changed. */
export const useLibraryStore = defineStore('library', () => {
  const items = ref<InstalledItem[]>([]);
  const loaded = ref(false);
  const refreshing = ref(false);
  let listSequence = 0;
  let storageSequence = 0;
  const storage = ref<StorageSummary | null>(null);

  const byKey = computed(() => new Map(items.value.map(item => [packageKey(item.kind, item.token), item])));
  const find = (kind: Kind, token: string) => byKey.value.get(packageKey(kind, token));

  async function load() {
    const current = ++listSequence;
    const result = onlyCasks(await unwrap(commands.libraryList()));
    if (current === listSequence) {
      items.value = result;
      loaded.value = true;
    }
  }

  /** Rerun brew info --json=v2 --installed. */
  async function refresh() {
    if (refreshing.value) return;
    const current = ++listSequence;
    refreshing.value = true;
    try {
      const result = onlyCasks(await unwrap(commands.libraryRefresh()));
      if (current === listSequence) {
        items.value = result;
        loaded.value = true;
      }
    } finally {
      refreshing.value = false;
    }
  }

  async function loadStorage() {
    const current = ++storageSequence;
    const result = await unwrap(commands.libraryStorage());
    if (current === storageSequence) storage.value = result;
  }

  return { items, loaded, refreshing, storage, byKey, find, load, refresh, loadStorage };
});
