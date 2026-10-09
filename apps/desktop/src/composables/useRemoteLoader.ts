import { toValue } from 'vue';
import type { WatchSource } from 'vue';
import { resourceCache } from './resourceCache';
import { useLoader } from './useLoader';

// Pages specify fixed namespaces; language, object, and query form the key so returning to a page can immediately show cached content.
const cached = resourceCache<unknown>();
export function useRemoteLoader<T>(namespace: string, fetcher: () => Promise<T>, sources: WatchSource[]) {
  const key = () => JSON.stringify([namespace, ...sources.map(source => toValue(source))]);
  return useLoader(
    () => cached(key(), fetcher) as Promise<T>,
    sources,
    undefined,
    sources,
    () => cached.peek(key()) as T | undefined
  );
}
