import Redis from 'ioredis';
import { pathToFileURL } from 'node:url';

const buildPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export async function cleanupBuild(client, { build, keep, apply = false }) {
  if (!buildPattern.test(build ?? '') || !keep?.length || keep.some(id => !buildPattern.test(id)))
    throw new Error('Specify one retired --build and at least one active --keep-build.');
  if (keep.includes(build)) throw new Error('Refusing to delete an active build.');
  const prefix = `opennavo:web:cache:${build}:`;
  let cursor = '0';
  let count = 0;
  let bytes = 0;
  const seen = new Set();
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 150);
    cursor = next;
    const keys = [...new Set(batch)].filter(key => key.startsWith(prefix) && !seen.has(key));
    keys.forEach(key => seen.add(key));
    // Bound pipeline/delete sizes even if Redis SCAN returns more than COUNT.
    for (let offset = 0; offset < keys.length; offset += 150) {
      const chunk = keys.slice(offset, offset + 150);
      const pipe = client.pipeline();
      chunk.forEach(key => pipe.memory('USAGE', key));
      const results = await pipe.exec();
      for (const [err, size] of results) {
        if (err) throw new Error('Cannot inspect cache memory; cleanup stopped.');
        bytes += Number(size ?? 0);
      }
      count += chunk.length;
      if (apply) await client.unlink(...chunk);
    }
  } while (cursor !== '0');
  return { build, apply, keys: count, approximateBytes: bytes };
}

async function main() {
  const args = process.argv.slice(2);
  const keep = [];
  let build;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--build') build = args[++i];
    else if (args[i] === '--keep-build') keep.push(args[++i]);
    else if (args[i] === '--apply') apply = true;
    else throw new Error('Unknown argument. Use --build RETIRED --keep-build ACTIVE [--apply].');
  }
  if (!process.env.CACHE_CLEANUP_REDIS_URL)
    throw new Error('Set CACHE_CLEANUP_REDIS_URL to the cache database to inspect.');
  const client = new Redis(process.env.CACHE_CLEANUP_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    retryStrategy: () => null
  });
  client.on('error', () => {});
  try {
    console.log(JSON.stringify(await cleanupBuild(client, { build, keep, apply })));
  } finally {
    client.disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Cache cleanup failed. Check arguments and connectivity; no broad deletion is performed.');
    process.exitCode = 1;
  });
}
