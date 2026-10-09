// Radio groups/segments/tabs: arrows move/select, Home/End jump, skip disabled options.

export type RovingKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

const KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function isRovingKey(key: string): key is RovingKey {
  return KEYS.has(key);
}

/** Selected index after a keypress, or -1 without selectable options. */
export function nextRovingIndex(key: RovingKey, current: number, enabled: readonly boolean[]): number {
  const count = enabled.length;
  const candidates = enabled.flatMap((ok, index) => (ok ? [index] : []));
  if (candidates.length === 0) return -1;
  if (key === 'Home') return candidates[0] ?? -1;
  if (key === 'End') return candidates[candidates.length - 1] ?? -1;
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  // Without selection, start before the first or after the last item.
  const start = current >= 0 ? current : step > 0 ? -1 : count;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((start + step * offset) % count) + count) % count;
    if (enabled[index]) return index;
  }
  return current;
}
