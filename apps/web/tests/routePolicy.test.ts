import { describe, expect, it, vi } from 'vitest';

// Evaluate the actual Nuxt configuration without starting Nuxt or a browser.
vi.stubGlobal('defineNuxtConfig', (config: unknown) => config);
const { default: config } = await import('../nuxt.config');
vi.unstubAllGlobals();

const prefixes = ['', '/zh', '/ja', '/es', '/pt', '/ru'];
const ttls: Record<string, number> = {
  '/': 300,
  '/discover': 300,
  '/about': 900,
  '/apps': 600,
  '/apps/**': 600,
  '/categories/**': 900,
  '/rankings': 900,
  '/download': 600
};

describe('robots.txt crawler groups', () => {
  const robots = config.robots as {
    disallow: string[];
    groups: { userAgent: string[]; disallow: string[] }[];
  };
  const group = (agent: string) => robots.groups.find(entry => entry.userAgent.includes(agent));

  it('blocks SEO-tool crawlers entirely', () => {
    for (const agent of ['MJ12bot', 'SerpstatBot']) expect(group(agent)?.disallow).toEqual(['/']);
  });

  it('keeps ClaudeBot off private pages, payloads and dependency tabs', () => {
    const claude = group('ClaudeBot');
    for (const path of robots.disallow) expect(claude?.disallow).toContain(path);
    expect(claude?.disallow).toEqual(expect.arrayContaining(['/*_payload.json', '/*/dependencies']));
  });

  it('leaves search engines and AI search agents on the default rules', () => {
    for (const agent of ['Googlebot', 'Bingbot', 'Claude-SearchBot', 'Claude-User', 'OAI-SearchBot', 'ChatGPT-User'])
      expect(group(agent), agent).toBeUndefined();
    expect(robots.disallow).not.toContain('/*_payload.json');
  });
});

describe('localized route policies', () => {
  it.each(prefixes)('preserves production cache TTLs at the actual %s locale paths', prefix => {
    for (const [path, swr] of Object.entries(ttls)) {
      const actualPath = path === '/' ? prefix || '/' : `${prefix}${path}`;
      expect(config.$production?.routeRules?.[actualPath], actualPath).toEqual({ swr });
      expect(config.routeRules?.[actualPath]?.swr).toBeUndefined();
    }
  });

  it.each(prefixes)('keeps %s search uncached and Brewfile client-only and excludes both from indexing', prefix => {
    const search = `${prefix}/search`;
    const brewfile = `${prefix}/brewfile`;
    expect(config.routeRules?.[search]).toEqual({ cache: false, headers: { 'cache-control': 'no-store' } });
    expect(config.$production?.routeRules?.[search]).toBeUndefined();
    expect(config.routeRules?.[brewfile]).toEqual({ ssr: false });
    expect(config.$production?.routeRules?.[brewfile]).toBeUndefined();
    const sitemap = config.sitemap as { sitemaps: { pages: { exclude: string[] } } };
    const robots = config.robots as { disallow: string[] };
    for (const path of [search, brewfile]) {
      expect(sitemap.sitemaps.pages.exclude).toContain(path);
      expect(robots.disallow).toContain(path);
    }
  });

  it.each(prefixes)('does not cache %s collection HTML or extracted payloads', prefix => {
    for (const path of ['/collections', '/collections/**']) {
      expect(config.routeRules?.[`${prefix}${path}`]).toEqual({
        cache: false,
        headers: { 'cache-control': 'no-store' }
      });
      expect(config.$production?.routeRules?.[`${prefix}${path}`]).toBeUndefined();
    }
  });

  it('does not generate obsolete English prefixes or broad cache rules covering search', () => {
    const production = config.$production?.routeRules ?? {};
    expect(Object.keys(production)).toHaveLength(prefixes.length * Object.keys(ttls).length);
    for (const path of [...Object.keys(production), ...Object.keys(config.routeRules ?? {})]) {
      expect(path).not.toMatch(/^\/en(?:\/|$)/);
      expect(path).not.toMatch(/^(?:\/zh|\/ja|\/es|\/pt|\/ru)?\/\*\*$/);
    }
  });
});
