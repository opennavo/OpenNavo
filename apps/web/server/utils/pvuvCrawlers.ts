import { getHeader, type H3Event } from 'h3';
import { clientIP } from './client-ip';

// Server-side crawler reporting for pvuv.ai (api.pvuv.ai/docs/crawler-sync.md). AI crawlers such as
// ChatGPT-User, GPTBot and ClaudeBot fetch the HTML and never run the beacon, so the browser SDK
// cannot see them; the origin reports them instead. The ingest-only token can submit hits and read
// nothing. Requests are reported after the response finishes, and a failed report stays invisible.

const CRAWLER_UA =
  /chatgpt-user|oai-searchbot|gptbot|perplexity-user|perplexitybot|claude-user|claude-searchbot|claudebot|bingbot|googlebot|applebot|duckduckbot|duckassistbot|yandexbot|meta-externalagent|bytespider/i;

const PAGE_EXTENSION = /\.(?:html?|txt|xml|md)$/i;
const STATIC_EXTENSION =
  /\.(?:js|mjs|css|map|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|webmanifest|pdf|zip|gz|tgz|dmg|pkg|exe|msi|apk|ipa|mp4|webm|wasm)$/i;

export interface PvuvCrawlerRequest {
  ua: string;
  path: string;
  ip?: string;
}

export interface PvuvCrawlerHit extends PvuvCrawlerRequest {
  status: number;
  ts: number;
  id: string;
}

/** Documents and extensionless routes are pages; API, internal and asset paths are not. */
export function isPvuvPagePath(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false;
  if (pathname.startsWith('/api/') || pathname.startsWith('/_')) return false;
  if (PAGE_EXTENSION.test(pathname)) return true;
  return !STATIC_EXTENSION.test(pathname);
}

export function isPvuvCrawler(userAgent: string | undefined): boolean {
  return Boolean(userAgent && CRAWLER_UA.test(userAgent));
}

/** What pvuv needs from an eligible request, or null when this request is not one they collect. */
export function pvuvCrawlerRequest(event: H3Event, trustedProxies: string): PvuvCrawlerRequest | null {
  if (event.method !== 'GET' && event.method !== 'HEAD') return null;
  const ua = getHeader(event, 'user-agent');
  if (!isPvuvCrawler(ua)) return null;
  const path = (event.path.split('?')[0] ?? '') || '/';
  if (!isPvuvPagePath(path)) return null;
  // client-ip.ts already verified the forwarded address; fall back to the same rule if it did not run.
  const ip =
    (event.context.publicApiClientIP as string | undefined) ??
    clientIP(event.node.req.socket.remoteAddress, getHeader(event, 'x-forwarded-for'), trustedProxies);
  return { ua: ua as string, path, ...(ip ? { ip } : {}) };
}

/** Fire and forget: a slow or failed report must never delay or break the page response. */
export async function sendPvuvCrawlerHit(token: string, siteId: string, hit: PvuvCrawlerHit): Promise<void> {
  try {
    await fetch(`https://api.pvuv.ai/v1/sites/${encodeURIComponent(siteId)}/crawler_hits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hits: [hit] }),
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // Best effort: the crawler's next request reports itself.
  }
}
