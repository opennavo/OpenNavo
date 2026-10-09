import { computed, shallowRef } from 'vue';
import type { TreeSelectOption } from 'naive-ui';
import { fetchCategoryTree } from '@/service/api';
import type { Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { pickLocalized } from '@/utils/content-locale';
import { useAuth } from './auth';

type CategoryNode = Schemas['AdminCategoryNode'];

// Share category trees across filters, package categories, and features; load once per session, reload after category edits.
// Reads require catalog:package:view; do not request without permission.
const tree = shallowRef<CategoryNode[]>([]);
let pending: Promise<void> | null = null;

async function reload() {
  const { data, error } = await fetchCategoryTree();
  if (!error) tree.value = data;
}

export function useCategoryTree() {
  const appStore = useAppStore();
  const { hasAuth } = useAuth();
  const readable = hasAuth('catalog:package:view');
  if (readable && !pending) pending = reload();

  const nameOf = (node: CategoryNode) =>
    pickLocalized(node.i18n, appStore.locale, node.sourceLocale)?.name || node.slug;

  const options = computed<TreeSelectOption[]>(() => {
    const map = (nodes: CategoryNode[]): TreeSelectOption[] =>
      nodes.map(node => ({
        key: node.id,
        label: nameOf(node),
        children: node.children.length ? map(node.children) : undefined
      }));
    return map(tree.value);
  });

  /** ID → name, including subcategories. */
  const names = computed(() => {
    const out = new Map<number, string>();
    const walk = (nodes: CategoryNode[]) =>
      nodes.forEach(node => {
        out.set(node.id, nameOf(node));
        walk(node.children);
      });
    walk(tree.value);
    return out;
  });

  return {
    readable,
    tree,
    options,
    names,
    nameOf,
    reload: async () => {
      pending = reload();
      await pending;
    }
  };
}
