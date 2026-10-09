// Toast queue: create separately for web/desktop, never a module singleton shared across SSR requests; use with OnToastRegion.
import { readonly, ref } from 'vue';
import type { OnToastItem } from '../components/OnToastRegion.vue';

export type OnToastInput = Omit<OnToastItem, 'id'> & { id?: string };

export function createToastQueue() {
  const items = ref<OnToastItem[]>([]);
  let sequence = 0;

  /** Add a toast and return its ID; replace existing same-ID toasts, e.g. task progress updates. */
  function push(toast: OnToastInput): string {
    sequence += 1;
    const id = toast.id ?? `toast-${sequence}`;
    items.value = [...items.value.filter(item => item.id !== id), { ...toast, id }];
    return id;
  }

  function dismiss(id: string) {
    items.value = items.value.filter(item => item.id !== id);
  }

  function clear() {
    items.value = [];
  }

  return { items: readonly(items), push, dismiss, clear };
}

export type ToastQueue = ReturnType<typeof createToastQueue>;
