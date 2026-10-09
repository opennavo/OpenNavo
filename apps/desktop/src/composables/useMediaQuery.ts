import { onBeforeUnmount, ref } from 'vue';
import type { Ref } from 'vue';

/** Reactive media-query result, updated when window width changes. */
export function useMediaQuery(query: string): Ref<boolean> {
  const media = window.matchMedia(query);
  const matches = ref(media.matches);
  const update = (event: MediaQueryListEvent) => {
    matches.value = event.matches;
  };
  media.addEventListener('change', update);
  onBeforeUnmount(() => media.removeEventListener('change', update));
  return matches;
}
