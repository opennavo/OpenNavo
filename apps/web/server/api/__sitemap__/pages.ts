import { LOCALES, LOCALE_METADATA } from '@opennavo/shared';

// Category/collection sitemap URLs (05 §6.4); sitemap generates static pages from routes.
interface CategoryNode {
  slug: string;
  hiddenByDefault: boolean;
  children: CategoryNode[];
}

interface CollectionPage {
  data: { total: number; records: { slug: string; updatedAt: string }[] };
}

function flatten(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}

function localized(path: string, lastmod?: string) {
  const alternatives = [
    ...LOCALES.map(code => ({
      hreflang: LOCALE_METADATA[code].hreflang,
      href: `${LOCALE_METADATA[code].prefix}${path}`
    })),
    { hreflang: 'x-default', href: path }
  ];
  return LOCALES.map(code => ({ loc: `${LOCALE_METADATA[code].prefix}${path}`, lastmod, alternatives }));
}

export default defineSitemapEventHandler(async () => {
  const config = useRuntimeConfig();
  const base = (config.apiBaseInternal || config.public.apiBase).replace(/\/$/, '');
  const categories = await $fetch<{ data: CategoryNode[] }>(`${base}/categories`);
  const urls = flatten(categories.data)
    .filter(node => !node.hiddenByDefault)
    .flatMap(node => localized(`/categories/${node.slug}`));
  for (let current = 1; ; current += 1) {
    const page = await $fetch<CollectionPage>(`${base}/collections`, { query: { current, size: 100 } });
    urls.push(...page.data.records.flatMap(item => localized(`/collections/${item.slug}`, item.updatedAt)));
    if (page.data.records.length < 100 || current * 100 >= page.data.total) break;
  }
  return urls;
});
