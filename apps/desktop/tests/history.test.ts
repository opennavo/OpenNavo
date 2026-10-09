import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands } from '@/ipc/client';
import { i18n } from '@/i18n';
import HistoryList from '@/components/updates/HistoryList.vue';
import UpdatesPage from '@/pages/UpdatesPage.vue';
import { setup } from './helpers';

let intersect: IntersectionObserverCallback;
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('Updates history loads 20 initially and stops at the latest 50', async () => {
  const context = await setup('/updates');
  const sample = context.state.history[0]!;
  context.state.history = Array.from({ length: 110 }, (_, i) => ({ ...sample, op: 'upgrade', id: `scroll-${i}` }));
  const spy = vi.spyOn(commands, 'historyList');
  const wrapper = mount(UpdatesPage, { global: { plugins: [context.pinia, context.router, i18n] } });
  await flushPromises();
  expect(wrapper.findComponent(HistoryList).props('tasks')).toHaveLength(20);
  for (const count of [40, 50]) {
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flushPromises();
    expect(wrapper.findComponent(HistoryList).props('tasks')).toHaveLength(count);
  }
  expect(spy.mock.calls.map(([query]) => [query.offset, query.limit])).toEqual([
    [0, 20],
    [20, 20],
    [40, 10]
  ]);
  expect(wrapper.findAll('button').some(button => button.text().includes(i18n.global.t('common.loadMore')))).toBe(
    false
  );
  wrapper.unmount();
});

it('Monthly history traverses all pages without 200/500-entry truncation', async () => {
  const { loadHistory } = await import('@/utils/history');
  const context = await setup('/updates');
  const sample = context.state.history[0]!;
  const now = Date.now();
  context.state.history = Array.from({ length: 521 }, (_, i) => ({
    ...sample,
    id: `month-${i}`,
    op: 'upgrade',
    state: i % 2 ? 'failed' : 'succeeded',
    finishedAt: now
  }));
  const result = await loadHistory({
    q: null,
    ops: ['upgrade'],
    states: ['succeeded', 'failed'],
    target: null,
    includeScheduledUpdates: false,
    from: now - 1,
    to: null,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0
  });
  expect(result.total).toBe(521);
  expect(result.items).toHaveLength(521);
  expect(new Set(result.items.map(task => task.id)).size).toBe(521);
  expect(result.items.filter(task => task.state === 'succeeded')).toHaveLength(261);
});

it('Legacy formula rows do not consume visible history pages or the 50-row cap', async () => {
  const context = await setup('/updates');
  const sample = context.state.history[0]!;
  context.state.history = [
    ...Array.from({ length: 60 }, (_, i) => ({
      ...sample,
      op: 'upgrade' as const,
      id: `formula-${i}`,
      target: { kind: 'formula' as const, token: 'node' }
    })),
    ...Array.from({ length: 70 }, (_, i) => ({
      ...sample,
      op: 'upgrade' as const,
      id: `app-${i}`,
      target: { kind: 'cask' as const, token: 'firefox' }
    }))
  ];
  const wrapper = mount(UpdatesPage, { global: { plugins: [context.pinia, context.router, i18n] } });
  try {
    await flushPromises();
    expect(wrapper.findComponent(HistoryList).props('tasks')).toHaveLength(20);
    for (const count of [40, 50]) {
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await flushPromises();
      expect(wrapper.findComponent(HistoryList).props('tasks')).toHaveLength(count);
    }
    expect(
      wrapper
        .findComponent(HistoryList)
        .props('tasks')
        .every((task: { id: string }) => task.id.startsWith('app-'))
    ).toBe(true);
    expect(wrapper.findAll('button').some(button => button.text().includes(i18n.global.t('common.loadMore')))).toBe(
      false
    );
  } finally {
    wrapper.unmount();
  }
});
