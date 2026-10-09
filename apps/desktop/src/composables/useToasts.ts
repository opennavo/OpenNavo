import { createToastQueue } from '@opennavo/ui';
import type { ToastQueue } from '@opennavo/ui';

// The client has one window instance and a global toast queue, rendered by the shell's OnToastRegion.
const queue = createToastQueue();

export function useToasts(): ToastQueue {
  return queue;
}
