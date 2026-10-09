import { describe, expect, it } from 'vitest';
import {
  addToBrewfileList,
  BREWFILE_MAX,
  moveInBrewfileList,
  parseBrewfileList,
  removeFromBrewfileList,
  type BrewfileListItem
} from '../src/brewfileList';

const item = (token: string): BrewfileListItem => ({ kind: 'cask', token, addedAt: '2026-01-01T00:00:00.000Z' });

describe('persisted Brewfile lists', () => {
  it.each([null, '', '{invalid', '{}', 'null'])('recovers safely from invalid storage: %s', raw => {
    expect(parseBrewfileList(raw)).toEqual([]);
  });

  it('drops legacy formulas, malformed entries, unsafe tokens and duplicates', () => {
    const raw = JSON.stringify([
      null,
      1,
      'text',
      {},
      { kind: 1 },
      { kind: 'unknown' },
      { kind: 'formula', token: 'git' },
      { kind: 'cask', token: 1 },
      { kind: 'cask', token: '--unsafe' },
      item('firefox'),
      item('firefox'),
      { kind: 'cask', token: 'ghostty' }
    ]);
    expect(parseBrewfileList(raw)).toEqual([item('firefox'), { kind: 'cask', token: 'ghostty', addedAt: '' }]);
  });

  it('caps stored lists without changing their order', () => {
    const entries = Array.from({ length: BREWFILE_MAX + 5 }, (_, i) => item(`app-${i}`));
    expect(parseBrewfileList(JSON.stringify(entries))).toEqual(entries.slice(0, BREWFILE_MAX));
  });
});

describe('Brewfile list editing', () => {
  it('adds once with a timestamp and never mutates the original list', () => {
    const original = Object.freeze([item('firefox')]);
    const now = new Date('2026-02-01T00:00:00Z');
    const added = addToBrewfileList(original, 'cask', 'ghostty', now);
    expect(added).toEqual({
      result: 'added',
      list: [item('firefox'), { kind: 'cask', token: 'ghostty', addedAt: now.toISOString() }]
    });
    expect(addToBrewfileList(added.list, 'cask', 'ghostty', now)).toEqual({ result: 'exists', list: added.list });
    expect(original).toEqual([item('firefox')]);
  });

  it('keeps a full list intact and reports duplicates before capacity', () => {
    const original = Array.from({ length: BREWFILE_MAX }, (_, i) => item(`app-${i}`));
    expect(addToBrewfileList(original, 'cask', 'extra', new Date())).toEqual({ result: 'full', list: original });
    expect(addToBrewfileList(original, 'cask', 'app-0', new Date()).result).toBe('exists');
  });

  it('removes only the matching kind and token', () => {
    const original = [item('firefox'), { ...item('firefox'), kind: 'formula' as const }, item('ghostty')];
    expect(removeFromBrewfileList(original, 'cask', 'firefox')).toEqual(original.slice(1));
    expect(removeFromBrewfileList(original, 'cask', 'missing')).toEqual(original);
  });

  it('reorders in both directions without losing entries or mutating storage', () => {
    const original = Object.freeze([item('firefox'), item('ghostty'), item('raycast')]);
    expect(moveInBrewfileList(original, 0, 2)).toEqual([original[1], original[2], original[0]]);
    expect(moveInBrewfileList(original, 2, 0)).toEqual([original[2], original[0], original[1]]);
    expect(original.map(row => row.token)).toEqual(['firefox', 'ghostty', 'raycast']);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [0, -1],
    [3, 0],
    [0, 3]
  ])('ignores invalid/no-op moves %s → %s', (from, to) => {
    const original = [item('firefox'), item('ghostty')];
    expect(moveInBrewfileList(original, from, to)).toEqual(original);
  });
});
