// Pagination (08 §8.28): at most max slots including ellipses, always first/last/current pages.

export type PaginationItem = { type: 'page'; page: number } | { type: 'ellipsis'; key: 'start' | 'end' };

export function paginationRange(current: number, total: number, max = 7): PaginationItem[] {
  const pageCount = Math.max(1, Math.floor(total));
  const page = Math.min(Math.max(1, Math.floor(current)), pageCount);
  const slots = Math.max(5, max);
  const pages = (from: number, to: number): PaginationItem[] =>
    Array.from({ length: to - from + 1 }, (_, index) => ({ type: 'page', page: from + index }));

  if (pageCount <= slots) return pages(1, pageCount);

  // Reserve slots for first/last and both ellipses; use the middle for current-page neighbors.
  const middle = slots - 4;
  const half = Math.floor(middle / 2);
  let start = page - half;
  let end = start + middle - 1;
  if (start <= 3) {
    return [...pages(1, slots - 2), { type: 'ellipsis', key: 'end' }, { type: 'page', page: pageCount }];
  }
  if (end >= pageCount - 2) {
    return [
      { type: 'page', page: 1 },
      { type: 'ellipsis', key: 'start' },
      ...pages(pageCount - (slots - 3), pageCount)
    ];
  }
  start = Math.max(start, 3);
  end = Math.min(end, pageCount - 2);
  return [
    { type: 'page', page: 1 },
    { type: 'ellipsis', key: 'start' },
    ...pages(start, end),
    { type: 'ellipsis', key: 'end' },
    { type: 'page', page: pageCount }
  ];
}
