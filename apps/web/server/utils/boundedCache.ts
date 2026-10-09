import type { Driver } from 'unstorage';

export const PAGE_CACHE_TTL_SECONDS = 3600;
export const IMAGE_CACHE_TTL_SECONDS = 6 * 3600;
export const MAX_CACHE_ENTRY_BYTES = 512 * 1024;

// Bound actual Redis retention, including callers that supply their own TTL.
export function boundedCache(driver: Driver): Driver {
  return {
    ...driver,
    async setItem(key, value, options) {
      if (Buffer.byteLength(value, 'utf8') > MAX_CACHE_ENTRY_BYTES) {
        await driver.removeItem?.(key, options);
        return;
      }
      const ceiling = key.startsWith('nuxt-og-image:') ? IMAGE_CACHE_TTL_SECONDS : PAGE_CACHE_TTL_SECONDS;
      const requested = options?.ttl;
      const ttl =
        typeof requested === 'number' && Number.isFinite(requested) && requested > 0
          ? Math.max(1, Math.min(Math.floor(requested), ceiling))
          : ceiling;
      await driver.setItem?.(key, value, { ...options, ttl });
    }
  };
}
