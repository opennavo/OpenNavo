import { unwrap } from '@opennavo/api';
import type { HomeData } from '@opennavo/api';
import { api } from '@/api';
import { resourceCache } from './resourceCache';

const cached = resourceCache<HomeData>();
export const peekHome = (locale: string) => cached.peek(locale);

export function fetchHome(locale: string): Promise<HomeData> {
  return cached(locale, () => unwrap(api.GET('/home', { headers: { 'Accept-Language': locale } })));
}
