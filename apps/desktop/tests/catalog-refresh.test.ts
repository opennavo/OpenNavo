import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { i18n } from '@/i18n';
import { commands, events, unwrap } from '@/ipc/client';
import type { LocalItem } from '@/ipc/client';
import { startLocalState, startTrayState, useCatalogStore } from '@/stores';
import { useNamesStore } from '@/stores/names';
import { usePackageIdentity } from '@/composables/usePackageIdentity';
import CategoryPage from '@/pages/CategoryPage.vue';
import { setup } from './helpers';

const wrappers: { unmount: () => void }[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks();
});

async function firstJapaneseSwitch() {
  const context = await setup();
  await startLocalState();
  const original = await unwrap(commands.catalogGet('cask', 'visual-studio-code'));
  if (!original) throw new Error('missing fixture');
  const old: LocalItem = {
    ...original,
    displayName: { 'en-US': 'English Editor' },
    summary: { 'en-US': 'English summary' }
  };
  const translated: LocalItem = {
    ...old,
    displayName: { ...old.displayName, 'ja-JP': '日本語エディター' },
    summary: { ...old.summary, 'ja-JP': '日本語の説明' }
  };
  const settings = await unwrap(commands.settingsGet());
  await unwrap(commands.settingsSet({ ...settings, locale: 'ja-JP', localeMode: 'manual' }));
  i18n.global.locale.value = 'ja-JP';
  await flushPromises();
  return { ...context, old, translated };
}

async function synced() {
  const status = await unwrap(commands.catalogStatus());
  // The language-pack version changed, but the package count and catalog cursor did not.
  await events.catalogSynced.emit(status);
  await flushPromises();
}

describe('Refresh existing pages after first language-pack sync', () => {
  it('Reread cached names, preserving English fallback during download and rejecting stale queries over Japanese', async () => {
    const { pinia, old, translated } = await firstJapaneseSwitch();
    const names = useNamesStore();
    names.remember([old]);
    const Probe = defineComponent({
      setup() {
        const { displayName } = usePackageIdentity();
        return () => h('p', displayName('cask', old.token));
      }
    });
    const wrapper = mount(Probe, { global: { plugins: [pinia, i18n] } });
    wrappers.push(wrapper);
    expect(wrapper.text()).toBe('English Editor');
    let finish!: (value: Awaited<ReturnType<typeof commands.catalogGet>>) => void;
    const get = vi
      .spyOn(commands, 'catalogGet')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ status: 'ok', data: translated });
    const previous = names.refresh();
    await synced();
    expect(wrapper.text()).toBe('日本語エディター');
    finish({ status: 'ok', data: old });
    await previous;
    await flushPromises();
    expect(wrapper.text()).toBe('日本語エディター');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('Sync updates category names/summaries to Japanese without route or locale changes', async () => {
    const { pinia, router, old, translated } = await firstJapaneseSwitch();
    const list = vi
      .spyOn(commands, 'catalogList')
      .mockResolvedValue({ status: 'ok', data: { total: 1, items: [old] } });
    const wrapper = mount(CategoryPage, {
      props: { slug: 'development' },
      global: { plugins: [pinia, router, i18n] }
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.text()).toContain('English summary');
    list.mockResolvedValue({ status: 'ok', data: { total: 1, items: [translated] } });
    vi.spyOn(commands, 'catalogGet').mockResolvedValue({ status: 'ok', data: translated });
    const revision = useCatalogStore().revision;
    await synced();
    expect(useCatalogStore().revision).toBe(revision + 1);
    expect(wrapper.text()).toContain('日本語エディター');
    expect(wrapper.text()).toContain('日本語の説明');
    expect(wrapper.text()).not.toContain('English summary');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('Late pre-sync lists cannot revert installed/update name caches to English', async () => {
    const { pinia, router, old, translated } = await firstJapaneseSwitch();
    const names = useNamesStore();
    names.remember([old]);
    let finish!: (value: Awaited<ReturnType<typeof commands.catalogList>>) => void;
    vi.spyOn(commands, 'catalogList')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      )
      .mockResolvedValue({ status: 'ok', data: { total: 1, items: [translated] } });
    vi.spyOn(commands, 'catalogGet').mockResolvedValue({ status: 'ok', data: translated });
    const wrapper = mount(CategoryPage, {
      props: { slug: 'development' },
      global: { plugins: [pinia, router, i18n] }
    });
    wrappers.push(wrapper);
    await synced();
    expect(wrapper.text()).toContain('日本語の説明');
    expect(names.lookup('cask', old.token)?.displayName['ja-JP']).toBe('日本語エディター');
    finish({ status: 'ok', data: { total: 1, items: [old] } });
    await flushPromises();
    expect(wrapper.text()).toContain('日本語の説明');
    expect(names.lookup('cask', old.token)?.displayName['ja-JP']).toBe('日本語エディター');
  });

  it('Tray rereads names without main-window-only category/status commands', async () => {
    const { old, translated } = await firstJapaneseSwitch();
    // Reinstall simulated events to isolate earlier main-window subscriptions.
    const { installMockIpc } = await import('@/ipc/mock');
    installMockIpc();
    await startTrayState();
    const names = useNamesStore();
    names.remember([old]);
    const get = vi.spyOn(commands, 'catalogGet').mockResolvedValue({ status: 'ok', data: translated });
    const categories = vi.spyOn(commands, 'catalogCategories');
    const status = vi.spyOn(commands, 'catalogStatus');
    await events.catalogSynced.emit({ cursor: 60, itemCount: 40, syncedAt: 1, syncing: false });
    await flushPromises();
    expect(names.lookup('cask', old.token)?.displayName['ja-JP']).toBe('日本語エディター');
    expect(get).toHaveBeenCalledWith('cask', old.token);
    expect(categories).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});

describe('Font catalog visibility', () => {
  it('Normal lists include fonts; explicit exclusion applies even to font categories', async () => {
    await setup();
    const query = {
      kind: 'cask' as const,
      category: null,
      sort: 'popular' as const,
      includeFonts: true,
      includeLibraries: false,
      includeDisabled: false,
      limit: 200,
      offset: 0
    };
    const all = await unwrap(commands.catalogList(query));
    expect(all.items.some(item => item.isFont)).toBe(true);
    const excluded = await unwrap(commands.catalogList({ ...query, category: 'fonts', includeFonts: false }));
    expect(excluded.total).toBe(0);
  });
  it('Font categories explicitly include fonts and display real mock results', async () => {
    const { pinia, router } = await setup();
    await startLocalState();
    const list = vi.spyOn(commands, 'catalogList');
    const wrapper = mount(CategoryPage, {
      props: { slug: 'fonts' },
      global: { plugins: [pinia, router, i18n] }
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ category: 'fonts', includeFonts: true }));
    expect(wrapper.text()).toContain('JetBrains Mono');
  });
});
