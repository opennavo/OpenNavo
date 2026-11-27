import { describe, expect, it } from 'vitest';
import { historyDay } from '@/hermes/historyDays';

describe('Hermes history day buckets', () => {
  it('uses local calendar days', () => {
    const now = new Date(2026, 4, 20, 10, 30).getTime();
    const yesterday = new Date(2026, 4, 19, 23, 59).getTime();
    const earlier = new Date(2026, 4, 18, 23, 59).getTime();
    expect(historyDay(now, now)).toBe('today');
    expect(historyDay(new Date(2026, 4, 20, 0, 1).getTime(), now)).toBe('today');
    expect(historyDay(yesterday, now)).toBe('yesterday');
    expect(historyDay(earlier, now)).toBe('earlier');
  });

  it('counts adjacent midnights across a DST transition as yesterday', () => {
    // In a zone with a spring-forward day, the local midnights are 23 hours apart. The
    // calendar comparison must still bucket the prior day as yesterday.
    const now = new Date(2026, 2, 9, 12, 0).getTime();
    const priorMidnight = new Date(2026, 2, 8, 0, 0).getTime();
    expect(historyDay(priorMidnight, now)).toBe('yesterday');
  });
});
