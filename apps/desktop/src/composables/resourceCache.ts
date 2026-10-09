import { CONTENT_TTL, registerInvalidator } from './usePageRefresh';

/** Successful data expires; only coalesce in-flight requests, never permanently cache failed or hanging Promises. */
export function resourceCache<T>(ttl = CONTENT_TTL) {
  const entries = new Map<string, { data?: T; updatedAt: number; pending?: Promise<T> }>();
  registerInvalidator(() => {
    for (const entry of entries.values()) entry.updatedAt = 0;
  });
  const read = (key: string, fetcher: () => Promise<T>): Promise<T> => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { updatedAt: 0 };
      entries.set(key, entry);
      // A page can stay open while browsing many apps; bound session cache size without evicting in-flight requests.
      if (entries.size > 128) {
        const oldest = [...entries].find(([candidate, value]) => candidate !== key && !value.pending);
        if (oldest) entries.delete(oldest[0]);
      }
    }
    if (entry.pending) return entry.pending;
    if (entry.data !== undefined && Date.now() - entry.updatedAt < ttl) return Promise.resolve(entry.data);
    const current = entry;
    current.pending = fetcher()
      .then(value => {
        current.data = value;
        current.updatedAt = Date.now();
        return value;
      })
      .finally(() => {
        current.pending = undefined;
      });
    return current.pending;
  };
  return Object.assign(read, { peek: (key: string) => entries.get(key)?.data });
}
