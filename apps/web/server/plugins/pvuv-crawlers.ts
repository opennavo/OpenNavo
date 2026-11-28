import { pvuvCrawlerRequest, sendPvuvCrawlerHit } from '../utils/pvuvCrawlers';

// Hosted pvuv.ai AI-crawler reporting (api.pvuv.ai/docs/crawler-sync.md). Crawlers such as
// ChatGPT-User, GPTBot and ClaudeBot fetch the HTML and never run the beacon, so the browser SDK
// cannot see them. Registered only when the ingest-only token and a valid site id are configured;
// hits are built after the response (so the status is final) and never awaited, so a slow or failed
// report cannot delay or break the page. The afterResponse hook also sees responses that middleware
// short-circuited, such as the load-shed 429s those crawlers receive.
const SITE_ID = /^[A-Za-z0-9]{4,16}$/;

export default defineNitroPlugin(nitroApp => {
  const config = useRuntimeConfig();
  const token = String(config.pvuvIngestToken ?? '').trim();
  const siteId = String(config.public.pvuvSiteId ?? '').trim();
  if (!token || !SITE_ID.test(siteId)) return;
  nitroApp.hooks.hook('afterResponse', event => {
    const request = pvuvCrawlerRequest(event, config.trustedProxies);
    if (!request) return;
    void sendPvuvCrawlerHit(token, siteId, {
      ...request,
      status: event.node.res.statusCode,
      ts: Date.now(),
      id: crypto.randomUUID()
    });
  });
});
