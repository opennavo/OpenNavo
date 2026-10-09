// List/category/ranking/search query parameters (05 §4: page/sort participate in cache keys); pure functions for tests.

export type CatalogSort = 'popular' | 'updated' | 'name';
export type RankingPeriod = '30d' | '90d' | '365d';

export const CATALOG_SORTS: readonly CatalogSort[] = ['popular', 'updated', 'name'];
export const RANKING_PERIODS: readonly RankingPeriod[] = ['30d', '90d', '365d'];

type QueryValue = string | null | (string | null)[] | undefined;

function first(value: QueryValue): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return item ?? undefined;
}

/** Page number: positive integer, otherwise one. */
export function readPage(value: QueryValue): number {
  const text = first(value);
  if (!text || !/^\d{1,6}$/.test(text)) return 1;
  return Math.max(1, Number(text));
}

export function readEnum<T extends string>(value: QueryValue, allowed: readonly T[], fallback: T): T {
  const text = first(value);
  return text !== undefined && (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
}

export function readFlag(value: QueryValue): boolean {
  return first(value) === '1';
}

/** Trim search terms and cap at 64 characters, matching API limits. */
export function readSearchQuery(value: QueryValue): string {
  return Array.from((first(value) ?? '').trim())
    .slice(0, 64)
    .join('');
}

/**
 * Merge query parameters, removing defaults/undefined/false for concise URLs and stable cache keys.
 * When changing filters, callers also set page undefined to return to page one.
 */
export function mergeQuery(
  current: Record<string, QueryValue>,
  patch: Record<string, string | number | boolean | undefined>,
  defaults: Record<string, string | number | boolean>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) {
    const text = first(value);
    if (text !== undefined && !(key in patch)) result[key] = text;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === false || value === defaults[key]) continue;
    result[key] = value === true ? '1' : String(value);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (result[key] === (value === true ? '1' : String(value))) delete result[key];
  }
  return result;
}
