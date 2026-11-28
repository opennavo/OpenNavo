import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPvuvCrawler, isPvuvPagePath, sendPvuvCrawlerHit } from '../server/utils/pvuvCrawlers';

afterEach(() => vi.unstubAllGlobals());

describe('isPvuvPagePath', () => {
  it.each(['/', '/zh', '/apps/1password-cli', '/robots.txt', '/sitemap_index.xml', '/llms.txt', '/feed.xml'])(
    'counts %s as a page',
    path => expect(isPvuvPagePath(path)).toBe(true)
  );

  it.each(['/api/v1/apps', '/_nuxt/entry.js', '/_ipx/a.png', '/img/logo.png', '/console.css', '/site.webmanifest'])(
    'skips %s',
    path => expect(isPvuvPagePath(path)).toBe(false)
  );
});

describe('isPvuvCrawler', () => {
  it.each([
    'ChatGPT-User/1.0',
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)',
    'GPTBot/1.2',
    'Perplexity-User/1.0',
    'PerplexityBot/1.0',
    'Claude-User/1.0',
    'Claude-SearchBot/1.0',
    'ClaudeBot/1.0',
    'bingbot/2.0',
    'Googlebot/2.1',
    'Applebot/0.1',
    'DuckDuckBot/1.0',
    'DuckAssistBot/1.0',
    'YandexBot/3.0',
    'meta-externalagent/1.1',
    'Bytespider'
  ])('matches %s', ua => expect(isPvuvCrawler(ua)).toBe(true));

  it.each([
    'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0) Chrome/134.0.0.0 Safari/537.36',
    'OpenNavo-Probe/1.0 IndexNow',
    ''
  ])('ignores %j', ua => expect(isPvuvCrawler(ua)).toBe(false));
});

describe('sendPvuvCrawlerHit', () => {
  it('posts one hit to the site endpoint with the ingest token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendPvuvCrawlerHit('ingest-token', 'NqrTDmAQ', {
      ua: 'GPTBot/1.2',
      path: '/apps/foo',
      ip: '203.0.113.7',
      status: 200,
      ts: 1_761_465_600_000,
      id: '0123456789abcdef'
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.pvuv.ai/v1/sites/NqrTDmAQ/crawler_hits');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'Bearer ingest-token', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      hits: [
        {
          ua: 'GPTBot/1.2',
          path: '/apps/foo',
          ip: '203.0.113.7',
          status: 200,
          ts: 1_761_465_600_000,
          id: '0123456789abcdef'
        }
      ]
    });
  });

  it('stays silent when the report fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      sendPvuvCrawlerHit('ingest-token', 'NqrTDmAQ', {
        ua: 'GPTBot/1.2',
        path: '/',
        status: 200,
        ts: 1,
        id: '0123456789abcdef'
      })
    ).resolves.toBeUndefined();
  });
});
