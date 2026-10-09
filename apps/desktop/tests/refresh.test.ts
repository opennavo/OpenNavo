import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { resourceCache } from '@/composables/resourceCache';
import { CONTENT_TTL, refreshPage, usePageRefresh } from '@/composables/usePageRefresh';
import { useLoader } from '@/composables/useLoader';
import AppSidebar from '@/components/shell/AppSidebar.vue';
import { i18n } from '@/i18n';
import { setup } from './helpers';

afterEach(() => vi.useRealTimers());

describe('Content cache and current-page recovery', () => {
  it('Isolate locales, reuse fresh data, refresh expired data, and preserve cache on failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    const cache = resourceCache<string>();
    const fetcher = vi.fn().mockResolvedValue('旧内容');
    await Promise.all([cache('zh', fetcher), cache('zh', fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache('en', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cache('zh', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CONTENT_TTL + 1);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(cache('zh', fetcher)).rejects.toThrow('offline');
    expect(cache.peek('zh')).toBe('旧内容');
    fetcher.mockResolvedValue('新内容');
    expect(await cache('zh', fetcher)).toBe('新内容');
  });

  it('Recovery avoids fresh-data rereads; manual refresh updates main/rail through one request', async () => {
    const cache = resourceCache<string>();
    const fetcher = vi.fn().mockResolvedValue('旧');
    const scope = effectScope();
    const loaders = scope.run(() => [
      useLoader(() => cache('home', fetcher)),
      useLoader(() => cache('home', fetcher))
    ])!;
    await flushPromises();
    await refreshPage(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue('新');
    const first = refreshPage();
    expect(refreshPage()).toBe(first);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(loaders.map(loader => loader.data.value)).toEqual(['新', '新']);
    scope.stop();
    await refreshPage();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('Show stale cache immediately; failed current pages recover through refresh', async () => {
    const scope = effectScope();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('恢复');
    const loader = scope.run(() => useLoader(fetcher, [], undefined, [], () => '缓存'))!;
    expect(loader.data.value).toBe('缓存');
    await flushPromises();
    expect(usePageRefresh().errors.value).toHaveLength(1);
    await refreshPage(false);
    expect(loader.data.value).toBe('恢复');
    expect(usePageRefresh().errors.value).toHaveLength(0);
    scope.stop();
  });

  it('Repeated Discover clicks refresh; detail Discover links only navigate back', async () => {
    const { pinia, router } = await setup('/discover');
    const scope = effectScope();
    const calls = vi.fn().mockResolvedValue('ok');
    scope.run(() => useLoader(calls, [ref('zh')]));
    await flushPromises();
    const wrapper = mount(AppSidebar, { global: { plugins: [pinia, router, i18n] } });
    await wrapper.get('a[href="/discover"]').trigger('click');
    await flushPromises();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('reselect')).toHaveLength(1);
    await router.push('/package/cask/test');
    await wrapper.get('a[href="/discover"]').trigger('click');
    await flushPromises();
    expect(calls).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    scope.stop();
  });
});

describe('Remote page return and locale isolation', () => {
  it('Returning shows cached details without reusing content across locale changes', async () => {
    const { useRemoteLoader } = await import('@/composables/useRemoteLoader');
    const locale = ref('zh');
    const fetcher = vi.fn().mockResolvedValue('中文');
    const first = effectScope();
    first.run(() => useRemoteLoader('test-detail', fetcher, [locale]));
    await flushPromises();
    first.stop();
    const second = effectScope();
    const loader = second.run(() => useRemoteLoader('test-detail', fetcher, [locale]))!;
    expect(loader.data.value).toBe('中文');
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    locale.value = 'en';
    expect(loader.data.value).toBeUndefined();
    await flushPromises();
    expect(loader.error.value).toBeInstanceOf(Error);
    second.stop();
  });
});

describe('Time and nonretryable errors', () => {
  it('Clock advances across months and timers clean up on unmount', async () => {
    const { useClock } = await import('@/composables/useClock');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 30));
    const scope = effectScope();
    const now = scope.run(useClock)!;
    expect(new Date(now.value).getMonth()).toBe(9);
    vi.advanceTimersByTime(60_000);
    expect(new Date(now.value).getMonth()).toBe(10);
    scope.stop();
    const last = now.value;
    vi.advanceTimersByTime(60_000);
    expect(now.value).toBe(last);
  });

  it('Network recovery does not repeat confirmed 404 requests', async () => {
    const { ApiError } = await import('@opennavo/api');
    const scope = effectScope();
    const fetcher = vi
      .fn()
      .mockRejectedValue(new ApiError({ code: '4040', status: 404, msg: 'missing', requestId: null }));
    scope.run(() => useLoader(fetcher));
    await flushPromises();
    await refreshPage(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});

describe('Refresh isolation between mounted resources', () => {
  it('Hung old-page requests cannot block new-page refresh or clear its state on completion', async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const oldScope = effectScope();
    const oldFetch = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishOld = resolve;
          })
      );
    oldScope.run(() => useLoader(oldFetch));
    await flushPromises();
    const oldRefresh = refreshPage();
    expect(usePageRefresh().loading.value).toBe(true);
    oldScope.stop();
    expect(usePageRefresh().loading.value).toBe(false);
    expect(usePageRefresh().refreshing.value).toBe(false);

    const newScope = effectScope();
    const newFetch = vi
      .fn()
      .mockResolvedValueOnce('new')
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finishNew = resolve;
          })
      );
    const loader = newScope.run(() => useLoader(newFetch))!;
    await flushPromises();
    expect(usePageRefresh().loading.value).toBe(false);
    const newRefresh = refreshPage();
    expect(newRefresh).not.toBe(oldRefresh);
    expect(newFetch).toHaveBeenCalledTimes(2);
    finishOld('late old');
    await oldRefresh;
    expect(usePageRefresh().refreshing.value).toBe(true);
    finishNew('fresh new');
    await newRefresh;
    expect(loader.data.value).toBe('fresh new');
    expect(usePageRefresh().loading.value).toBe(false);
    newScope.stop();
  });

  it('Failed new-page resources recover while old-page requests remain pending', async () => {
    let finishOld!: (value: string) => void;
    const oldScope = effectScope();
    oldScope.run(() =>
      useLoader(
        () =>
          new Promise<string>(resolve => {
            finishOld = resolve;
          })
      )
    );
    const oldRefresh = refreshPage();
    oldScope.stop();
    const newScope = effectScope();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('recovered');
    const loader = newScope.run(() => useLoader(fetcher))!;
    await flushPromises();
    await refreshPage(false);
    expect(loader.data.value).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    newScope.stop();
    finishOld('old');
    await oldRefresh;
  });
});

it('Old refreshes cannot occupy new-object state in reused components', async () => {
  let finishOld!: (value: string) => void;
  const target = ref('a');
  const scope = effectScope();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce('a')
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishOld = resolve;
        })
    )
    .mockResolvedValueOnce('b')
    .mockResolvedValueOnce('fresh b');
  const loader = scope.run(() => useLoader(fetcher, [target]))!;
  await flushPromises();
  const oldRefresh = refreshPage();
  target.value = 'b';
  await flushPromises();
  expect(usePageRefresh().loading.value).toBe(false);
  await refreshPage();
  expect(loader.data.value).toBe('fresh b');
  finishOld('late a');
  await oldRefresh;
  expect(loader.data.value).toBe('fresh b');
  scope.stop();
});
