// Brewfile list (05 §7.2): localStorage with pure helpers; reactive reads/writes live in composables/useBrewfileList.ts.
// Cask-only (ADR-018): discard stored legacy command-line entries and accept only Casks on insertion.
import { isPackageKind } from './types';
import { isValidToken } from './commands';
import type { PackageKind } from './types';

export const BREWFILE_KEY = 'onv:brewfile:v1';
export const BREWFILE_MAX = 200;

export interface BrewfileListItem {
  kind: PackageKind;
  token: string;
  addedAt: string;
}

export type AddResult = 'added' | 'exists' | 'full';

const sameItem = (kind: PackageKind, token: string) => (item: BrewfileListItem) =>
  item.kind === kind && item.token === token;

/** Parse storage, dropping malformed values, invalid names, and non-Casks; deduplicate and cap size. */
export function parseBrewfileList(raw: string | null): BrewfileListItem[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const result: BrewfileListItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { kind, token, addedAt } = entry as Record<string, unknown>;
    if (typeof kind !== 'string' || !isPackageKind(kind) || kind !== 'cask') continue;
    if (typeof token !== 'string' || !isValidToken(token)) continue;
    if (result.some(sameItem(kind, token))) continue;
    result.push({ kind, token, addedAt: typeof addedAt === 'string' ? addedAt : '' });
    if (result.length === BREWFILE_MAX) break;
  }
  return result;
}

export function addToBrewfileList(
  list: readonly BrewfileListItem[],
  kind: PackageKind,
  token: string,
  now: Date
): { list: BrewfileListItem[]; result: AddResult } {
  if (list.some(sameItem(kind, token))) return { list: [...list], result: 'exists' };
  if (list.length >= BREWFILE_MAX) return { list: [...list], result: 'full' };
  return { list: [...list, { kind, token, addedAt: now.toISOString() }], result: 'added' };
}

export function removeFromBrewfileList(
  list: readonly BrewfileListItem[],
  kind: PackageKind,
  token: string
): BrewfileListItem[] {
  return list.filter(item => !sameItem(kind, token)(item));
}

/** Move entry from → to for drag/up/down sorting; out-of-bounds moves leave data unchanged. */
export function moveInBrewfileList(list: readonly BrewfileListItem[], from: number, to: number): BrewfileListItem[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
