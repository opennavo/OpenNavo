import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useLoader } from '@/composables/useLoader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('Page data matches current identity', () => {
  it('Switching to failing B immediately clears A; late responses cannot restore old content', async () => {
    const scope = effectScope();
    const target = ref('A');
    const b = deferred<string>();
    const c = deferred<string>();
    const fetcher = vi.fn().mockResolvedValueOnce('A').mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
    const accepted = vi.fn();
    const loader = scope.run(() => useLoader<string>(fetcher, [target], accepted))!;
    await flushPromises();
    expect(loader.data.value).toBe('A');
    target.value = 'B';
    expect(loader.data.value).toBeUndefined();
    b.reject(new Error('offline'));
    await flushPromises();
    expect(loader.data.value).toBeUndefined();
    expect(accepted.mock.calls).toEqual([['A']]);
    expect(loader.error.value).toBeInstanceOf(Error);
    target.value = 'C';
    scope.stop();
    c.resolve('C');
    await flushPromises();
    expect(loader.data.value).toBeUndefined();
    expect(accepted.mock.calls).toEqual([['A']]);
  });

  it('Rapid switches accept only the latest response', async () => {
    const scope = effectScope();
    const target = ref('A');
    const a = deferred<string>();
    const b = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const accepted = vi.fn();
    const loader = scope.run(() => useLoader<string>(fetcher, [target], accepted))!;
    target.value = 'B';
    b.resolve('B');
    await flushPromises();
    a.resolve('A');
    await flushPromises();
    expect(loader.data.value).toBe('B');
    expect(accepted.mock.calls).toEqual([['B']]);
    scope.stop();
  });
});

describe('Refresh preserves data and coalesces requests', () => {
  it('Failed same-page refresh retains content and retry recovers', async () => {
    const scope = effectScope();
    const next = deferred<string>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('旧内容')
      .mockReturnValueOnce(next.promise)
      .mockResolvedValueOnce('新内容');
    const loader = scope.run(() => useLoader<string>(fetcher))!;
    await flushPromises();
    const first = loader.reload();
    expect(loader.reload()).toBe(first);
    expect(loader.data.value).toBe('旧内容');
    next.reject(new Error('offline'));
    await first;
    expect(loader.data.value).toBe('旧内容');
    expect(loader.error.value).toBeInstanceOf(Error);
    await loader.reload();
    expect(loader.data.value).toBe('新内容');
    expect(loader.error.value).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  it('Catalog revisions preserve content while identity changes clear it', async () => {
    const scope = effectScope();
    const identity = ref('a');
    const revision = ref(0);
    const pending = deferred<string>();
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockReturnValue(pending.promise);
    const loader = scope.run(() => useLoader(fetcher, [identity, revision], undefined, [identity]))!;
    await flushPromises();
    revision.value++;
    expect(loader.data.value).toBe('a');
    identity.value = 'b';
    expect(loader.data.value).toBeUndefined();
    scope.stop();
    pending.resolve('old');
    await flushPromises();
    expect(loader.data.value).toBeUndefined();
  });

  it('Synchronous failures remain retryable; unmounted loaders cannot request again', async () => {
    const scope = effectScope();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('IPC unavailable');
      })
      .mockResolvedValue('ok');
    const loader = scope.run(() => useLoader(fetcher))!;
    await flushPromises();
    await loader.reload();
    expect(loader.data.value).toBe('ok');
    scope.stop();
    await loader.reload();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
