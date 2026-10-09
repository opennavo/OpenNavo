import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DESKTOP_BREWFILE_KEY, useBrewfileStore } from '@/stores/brewfile';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => vi.restoreAllMocks());

describe('Desktop My List persistence', () => {
  it('restores order across app instances and prevents duplicates', () => {
    const list = useBrewfileStore();
    list.add('cask', 'zed');
    list.add('cask', 'firefox');
    list.add('cask', 'zed');
    list.move(1, 0);
    setActivePinia(createPinia());
    const restored = useBrewfileStore();
    expect(restored.items.map(item => item.token)).toEqual(['firefox', 'zed']);
    restored.remove('cask', 'firefox');
    expect(JSON.parse(localStorage.getItem(DESKTOP_BREWFILE_KEY)!)).toEqual(restored.items);
  });
  it('rejects unsupported and unsafe entries, and limits list size', () => {
    const list = useBrewfileStore();
    list.add('formula', 'wget');
    list.add('cask', '../unsafe');
    expect(list.items).toEqual([]);
    for (let i = 0; i < 201; i++) list.add('cask', `app-${i}`);
    expect(list.items).toHaveLength(200);
  });
  it('does not publish unsaved changes when storage fails', () => {
    const list = useBrewfileStore();
    list.add('cask', 'zed');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    list.remove('cask', 'zed');
    expect(list.has('cask', 'zed')).toBe(true);
    expect(list.storageError).toBe(true);
  });
  it('recovers from malformed persisted data', () => {
    localStorage.setItem(DESKTOP_BREWFILE_KEY, '{bad');
    const list = useBrewfileStore();
    expect(list.items).toEqual([]);
    list.add('cask', 'zed');
    expect(list.has('cask', 'zed')).toBe(true);
  });
});
