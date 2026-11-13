import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Live countdown for a card the runtime will withdraw at `deadline` (epoch ms).
 *
 * The card is decoration: the runtime and the gateway both enforce the deadline, so a missed tick
 * can never keep a request alive past it. A missing deadline shows nothing at all.
 */
export function useAskCountdown(deadline: () => number | null | undefined) {
  const now = ref(Date.now());
  let timer: number | undefined;

  onMounted(() => {
    timer = window.setInterval(() => {
      now.value = Date.now();
    }, 1000);
  });
  onBeforeUnmount(() => {
    if (timer !== undefined) window.clearInterval(timer);
  });

  const remaining = computed(() => {
    const at = deadline();
    if (typeof at !== 'number') return null;
    return Math.max(0, at - now.value);
  });

  /** `m:ss` — long approvals read better than a bare second count. */
  const label = computed(() => {
    if (remaining.value === null) return '';
    const seconds = Math.ceil(remaining.value / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  });

  return { remaining, label };
}
