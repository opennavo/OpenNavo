import { LOCALES, LOCALE_METADATA } from '@opennavo/shared';

// App sitemap (05 §6.4): page Go /sitemap/packages at 5000 entries, generate six-language URLs/alternates. Cask-only (ADR-018).
interface SitemapPage {
  data: {
    current: number;
    size: number;
    total: number;
    records: { kind: 'cask' | 'formula'; token: string; updatedAt: string }[];
  };
}

const PAGE_SIZE = 5000;

export default defineSitemapEventHandler(async () => {
  const config = useRuntimeConfig();
  const base = (config.apiBaseInternal || config.public.apiBase).replace(/\/$/, '');
  const urls = [];
  for (let current = 1; ; current += 1) {
    const page = await $fetch<SitemapPage>(`${base}/sitemap/packages`, { query: { current, size: PAGE_SIZE } });
    for (const entry of page.data.records) {
      // Backend returns only Casks; filter again to prevent legacy /cli URLs.
      if (entry.kind !== 'cask') continue;
      const path = `/apps/${entry.token}`;
      const alternatives = [
        ...LOCALES.map(code => ({
          hreflang: LOCALE_METADATA[code].hreflang,
          href: `${LOCALE_METADATA[code].prefix}${path}`
        })),
        { hreflang: 'x-default', href: path }
      ];
      // Explicitly assign packages: i18n mapping sends unmarked URLs into locale sitemaps, leaving sharded sitemaps empty.
      urls.push(
        ...LOCALES.map(code => ({
          loc: `${LOCALE_METADATA[code].prefix}${path}`,
          lastmod: entry.updatedAt,
          alternatives,
          _sitemap: 'packages'
        }))
      );
    }
    if (page.data.records.length < PAGE_SIZE || current * PAGE_SIZE >= page.data.total) break;
  }
  return urls;
});
