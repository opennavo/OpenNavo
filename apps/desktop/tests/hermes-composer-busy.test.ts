import { flushPromises, shallowMount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPage from '@/pages/AssistantPage.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { useHermesStore } from '@/stores/hermes';
import { setComposerText, setup } from './helpers';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => ['/tmp/photo.png'])
}));

const wrappers: VueWrapper[] = [];
const originalScrollTo = Element.prototype.scrollTo;

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  window.history.replaceState(null, '', '/?mock=hermes-ready');
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  Element.prototype.scrollTo = originalScrollTo;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

async function busyComposer() {
  const { pinia, router } = await setup('/assistant');
  const wrapper = shallowMount(AssistantPage, {
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body
  });
  wrappers.push(wrapper);
  await flushPromises();
  const store = useHermesStore();
  store.conversations = [{ id: 'busy-chat', messages: [], updatedAt: Date.now() }];
  store.activeId = 'busy-chat';
  store.thinking = true;
  await flushPromises();
  const send = vi.spyOn(store, 'send').mockResolvedValue(undefined);
  const stop = vi.spyOn(store, 'stop').mockResolvedValue(undefined);
  const textarea = wrapper.get<HTMLElement>('#hermes-composer');
  // The stable marker keeps the primary distinct from the standalone Stop that appears while the
  // primary is disabled.
  const primary = () => wrapper.get('[data-hermes-composer-primary] on-button-stub');
  const stopButton = () => wrapper.get('on-button-stub[aria-label="停止"]');
  return { wrapper, store, send, stop, textarea, primary, stopButton };
}

function pressEnter(target: HTMLElement) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: 13 });
  target.dispatchEvent(event);
}

describe('Hermes composer busy routing', () => {
  it('Turns the primary button into Stop when a running turn has an empty composer', async () => {
    const { stop, primary } = await busyComposer();

    const button = primary();
    expect(button.attributes('aria-label')).toBe('停止');
    await button.trigger('click');

    expect(stop).toHaveBeenCalled();
  });

  it('Labels a mid-turn send with the redirect policy and submits it', async () => {
    const { wrapper, store, send, textarea, primary } = await busyComposer();
    store.active!.busyMode = 'interrupt';
    await setComposerText(wrapper, 'use the API instead');
    await flushPromises();

    const button = primary();
    expect(button.attributes('aria-label')).toBe('打断并修正当前回复');
    expect(button.attributes('disabled')).toBe('false');

    pressEnter(textarea.element);
    await flushPromises();
    expect(send).toHaveBeenCalledWith('use the API instead', []);
  });

  it('Waits for the session event before routing mid-turn text, but still offers Stop', async () => {
    const { wrapper, stop, send, textarea, primary, stopButton } = await busyComposer();
    await setComposerText(wrapper, 'use the API instead');
    await flushPromises();

    expect(primary().attributes('aria-label')).toBe('打断并修正当前回复');
    expect(primary().attributes('disabled')).toBe('true');
    expect(wrapper.text()).not.toContain('↵ 打断并修正当前回复');

    pressEnter(textarea.element);
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
    expect(textarea.element.textContent).toBe('use the API instead');

    await stopButton().trigger('click');
    expect(stop).toHaveBeenCalled();
    expect(textarea.element.textContent).toBe('use the API instead');
  });

  it('Still offers Stop when attachments hold the primary for the next turn', async () => {
    const { wrapper, send, stop, textarea, primary, stopButton } = await busyComposer();
    vi.spyOn(commands, 'hermesAttachmentInfo').mockResolvedValue([
      { path: '/tmp/photo.png', name: 'photo.png', size: 3, isImage: false }
    ]);
    await wrapper.get('button[aria-label="添加附件"]').trigger('click');
    await flushPromises();
    await setComposerText(wrapper, 'look at this');
    await flushPromises();

    expect(primary().attributes('aria-label')).toBe('请等待当前回复结束再发送附件。');
    expect(primary().attributes('disabled')).toBe('true');
    expect(wrapper.text()).toContain('photo.png');

    pressEnter(textarea.element);
    await flushPromises();
    expect(send).not.toHaveBeenCalled();

    await stopButton().trigger('click');
    expect(stop).toHaveBeenCalled();
    expect(textarea.element.textContent).toBe('look at this');
    expect(wrapper.text()).toContain('photo.png');
  });

  it('Shows the queue policy when the runtime admits text as the next turn', async () => {
    const { wrapper, store, primary } = await busyComposer();
    store.active!.busyMode = 'queue';
    await setComposerText(wrapper, 'next, remember this');
    await flushPromises();

    expect(primary().attributes('aria-label')).toBe('排队发送');
    expect(primary().attributes('disabled')).toBe('false');
  });
});
