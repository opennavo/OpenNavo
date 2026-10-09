import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Kind, OutdatedItem, TaskTarget, UpdatesStatus } from '@/ipc/bindings';
import { commands, packageKey, unwrap } from '@/ipc/client';

// Cask-only catalog (ADR-018): neither show nor count command-line tools from brew outdated.
const onlyCasks = (list: OutdatedItem[]) => list.filter(item => item.kind === 'cask');

/**
 * Available updates (06 §6.8): updates_list reads cache; updates_check reruns brew outdated; reread after updates:changed.
 * Last/next check times come from updates_status (Rust schedules checks; the UI does not calculate them).
 */
export const useUpdatesStore = defineStore('updates', () => {
  const items = ref<OutdatedItem[]>([]);
  const loaded = ref(false);
  const status = ref<UpdatesStatus | null>(null);
  const requested = ref(false);
  const checking = computed(() => requested.value || Boolean(status.value?.checking));
  const checkedAt = computed(() => status.value?.checkedAt ?? null);
  const nextCheckAt = computed(() => status.value?.nextCheckAt ?? null);

  const byKey = computed(() => new Map(items.value.map(item => [packageKey(item.kind, item.token), item])));
  /** Items eligible for immediate updates, excluding pinned versions. */
  const actionable = computed(() => items.value.filter(item => !item.pinned && !item.ignored));
  const find = (kind: Kind, token: string) => byKey.value.get(packageKey(kind, token));

  async function loadStatus() {
    status.value = await unwrap(commands.updatesStatus());
  }

  async function load() {
    const [list] = await Promise.all([unwrap(commands.updatesList()), loadStatus().catch(() => undefined)]);
    items.value = onlyCasks(list);
    loaded.value = true;
  }

  async function check(runBrewUpdate: boolean) {
    requested.value = true;
    try {
      items.value = onlyCasks(await unwrap(commands.updatesCheck(runBrewUpdate)));
      loaded.value = true;
    } finally {
      requested.value = false;
      await loadStatus().catch(() => undefined);
    }
  }

  async function ignore(target: TaskTarget, version: string | null) {
    await unwrap(commands.updatesIgnore(target, version, null));
    await load();
  }

  return {
    items,
    loaded,
    status,
    checking,
    checkedAt,
    nextCheckAt,
    byKey,
    actionable,
    find,
    load,
    loadStatus,
    check,
    ignore
  };
});
