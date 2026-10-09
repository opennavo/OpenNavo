import { onScopeDispose, ref } from 'vue';

/** Time labels and cross-month queries must react to real time, not only business data changes. */
export function useClock() {
  const now = ref(Date.now());
  const tick = () => {
    now.value = Date.now();
  };
  const timer = window.setInterval(tick, 60_000);
  window.addEventListener('focus', tick);
  onScopeDispose(() => {
    window.clearInterval(timer);
    window.removeEventListener('focus', tick);
  });
  return now;
}
