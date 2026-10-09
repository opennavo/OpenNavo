import { ref } from 'vue';
import { defineStore } from 'pinia';
import { i18n } from '@/i18n';
import {
  addToBrewfileList,
  isValidToken,
  moveInBrewfileList,
  parseBrewfileList,
  removeFromBrewfileList
} from '@opennavo/shared';
import type { BrewfileListItem, PackageKind } from '@opennavo/shared';
import { useToasts } from '@/composables/useToasts';

export const DESKTOP_BREWFILE_KEY = 'onv:desktop:brewfile:v1';

/** Persist before publishing changes so a failed write never looks like a saved list. */
export const useBrewfileStore = defineStore('brewfile', () => {
  const { t } = i18n.global;
  const toasts = useToasts();
  const items = ref<BrewfileListItem[]>([]);
  const storageError = ref(false);
  try {
    items.value = parseBrewfileList(localStorage.getItem(DESKTOP_BREWFILE_KEY));
  } catch {
    storageError.value = true;
  }
  function save(next: BrewfileListItem[]) {
    try {
      localStorage.setItem(DESKTOP_BREWFILE_KEY, JSON.stringify(next));
      items.value = next;
      storageError.value = false;
      return true;
    } catch {
      storageError.value = true;
      toasts.push({ tone: 'danger', title: t('brewfile.saveFailed') });
      return false;
    }
  }
  const has = (kind: PackageKind, token: string) =>
    items.value.some(item => item.kind === kind && item.token === token);
  function add(kind: PackageKind, token: string) {
    if (kind !== 'cask' || !isValidToken(token)) return;
    const next = addToBrewfileList(items.value, kind, token, new Date());
    if (next.result === 'full') toasts.push({ tone: 'warning', title: t('brewfile.full') });
    if (next.result === 'added' && save(next.list)) toasts.push({ tone: 'success', title: t('brewfile.added') });
  }
  function remove(kind: PackageKind, token: string) {
    save(removeFromBrewfileList(items.value, kind, token));
  }
  function move(from: number, to: number) {
    save(moveInBrewfileList(items.value, from, to));
  }
  return { items, storageError, has, add, remove, move };
});
