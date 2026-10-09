import type { ToastQueue } from '@opennavo/ui';

/** Web toast queue injected by plugins/toasts.ts, displayed by layout OnToastRegion. */
export function useToasts(): ToastQueue {
  return useNuxtApp().$toasts;
}
