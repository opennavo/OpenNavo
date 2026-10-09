import { createToastQueue } from '@opennavo/ui';

// One toast queue per app instance; SSR requests never share queues.
export default defineNuxtPlugin(() => ({ provide: { toasts: createToastQueue() } }));
