export type HistoryDay = 'today' | 'yesterday' | 'earlier';

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Compare local calendar days, not 24-hour windows. A DST transition makes adjacent local
 * midnights 23 or 25 hours apart, so `today - 86_400_000` is not yesterday on those days.
 */
export function historyDay(value: number, now = Date.now()): HistoryDay {
  const today = startOfDay(now);
  const day = startOfDay(value);
  if (day === today) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return 'yesterday';
  return 'earlier';
}
