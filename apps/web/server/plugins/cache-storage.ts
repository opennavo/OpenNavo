import redisDriver from 'unstorage/drivers/redis';

import { boundedCache, PAGE_CACHE_TTL_SECONDS } from '../utils/boundedCache';

// Store Nitro SWR cache in Redis for shared instances (05 §5); use default memory cache without NUXT_REDIS_URL.
// Route caching is production-only; development already mounts cache, and remounting causes 500s (CI E2E injects NUXT_REDIS_URL).
export default defineNitroPlugin(() => {
  const { redisUrl, app } = useRuntimeConfig();
  if (!redisUrl || import.meta.dev) return;
  // Namespace by build: cached pages reference hashed /_nuxt assets that may not exist in replacement containers.
  useStorage().mount(
    'cache',
    boundedCache(
      redisDriver({
        url: redisUrl,
        base: `opennavo:web:cache:${app.buildId}`,
        ttl: PAGE_CACHE_TTL_SECONDS,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 1000
      })
    )
  );
});
