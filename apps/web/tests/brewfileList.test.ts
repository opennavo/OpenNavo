import { describe, expect, it } from 'vitest';
import {
  BREWFILE_MAX,
  addToBrewfileList,
  moveInBrewfileList,
  parseBrewfileList,
  removeFromBrewfileList
} from '../app/utils/brewfileList';

const now = new Date('2026-10-05T08:00:00Z');

describe('Brewfile list', () => {
  it('Parse storage, discarding malformed/invalid/non-Cask entries and deduplicating', () => {
    const raw = JSON.stringify([
      { kind: 'cask', token: 'visual-studio-code', addedAt: '2026-10-01T00:00:00Z' },
      { kind: 'cask', token: 'visual-studio-code', addedAt: '2026-10-02T00:00:00Z' },
      { kind: 'formula', token: 'python@3.14' },
      { kind: 'tap', token: 'x' },
      { kind: 'cask', token: '../etc/passwd' },
      'ghostty',
      null
    ]);
    expect(parseBrewfileList(raw)).toEqual([
      { kind: 'cask', token: 'visual-studio-code', addedAt: '2026-10-01T00:00:00Z' }
    ]);
    expect(parseBrewfileList(null)).toEqual([]);
    expect(parseBrewfileList('{oops')).toEqual([]);
    expect(parseBrewfileList('{"kind":"cask"}')).toEqual([]);
  });

  it('Add reports existing/full/success without mutating original list', () => {
    const list = parseBrewfileList(JSON.stringify([{ kind: 'cask', token: 'ghostty', addedAt: '' }]));
    const added = addToBrewfileList(list, 'cask', 'iterm2', now);
    expect(added.result).toBe('added');
    expect(added.list.at(-1)).toEqual({ kind: 'cask', token: 'iterm2', addedAt: '2026-10-05T08:00:00.000Z' });
    expect(list).toHaveLength(1);
    expect(addToBrewfileList(list, 'cask', 'ghostty', now).result).toBe('exists');

    const full = Array.from({ length: BREWFILE_MAX }, (_, index) => ({
      kind: 'cask' as const,
      token: `pkg${index}`,
      addedAt: ''
    }));
    expect(addToBrewfileList(full, 'cask', 'ghostty', now).result).toBe('full');
    expect(parseBrewfileList(JSON.stringify([...full, { kind: 'cask', token: 'more' }]))).toHaveLength(BREWFILE_MAX);
  });

  it('Remove only the matching package', () => {
    const list = [
      { kind: 'cask' as const, token: 'docker-desktop', addedAt: '' },
      { kind: 'cask' as const, token: 'orbstack', addedAt: '' }
    ];
    expect(removeFromBrewfileList(list, 'cask', 'orbstack')).toEqual([list[0]]);
  });
});

describe('Brewfile ordering', () => {
  it('Move to specified positions; out-of-bounds unchanged', () => {
    const list = ['a', 'b', 'c'].map(token => ({ kind: 'cask' as const, token, addedAt: '' }));
    const tokens = (items: typeof list) => items.map(item => item.token);
    expect(tokens(moveInBrewfileList(list, 0, 2))).toEqual(['b', 'c', 'a']);
    expect(tokens(moveInBrewfileList(list, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(tokens(moveInBrewfileList(list, 1, 5))).toEqual(['a', 'b', 'c']);
    expect(tokens(moveInBrewfileList(list, -1, 0))).toEqual(['a', 'b', 'c']);
  });
});
