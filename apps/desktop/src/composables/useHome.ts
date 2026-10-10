import { unwrap } from '@opennavo/api';
import type { HomeData, PackageSummary } from '@opennavo/api';
import { api } from '@/api';
import { resourceCache } from './resourceCache';

const cached = resourceCache<HomeData>();
const popularCached = resourceCache<PackageSummary[]>();
export const peekHome = (locale: string) => cached.peek(locale);
export const peekPopularApps = (locale: string) => popularCached.peek(locale);

// The home endpoint only provides twelve apps; fetch enough for three rows in wide desktop windows.
export function fetchPopularApps(locale: string): Promise<PackageSummary[]> {
  return popularCached(locale, async () => {
    const page = await unwrap(
      api.GET('/packages', {
        params: { query: { kind: 'cask', sort: 'popular', size: 30, includeFonts: true } },
        headers: { 'Accept-Language': locale }
      })
    );
    return page.records;
  });
}

export function fetchHome(locale: string): Promise<HomeData> {
  return cached(locale, () => unwrap(api.GET('/home', { headers: { 'Accept-Language': locale } })));
}
