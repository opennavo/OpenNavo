import { flushPromises, shallowMount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPage from '@/pages/AssistantPage.vue';
import AssistantHistory from '@/components/hermes/AssistantHistory.vue';
import { queueHermesNotificationOpen } from '@/hermes/notificationOpen';
import { i18n } from '@/i18n';
import { useHermesStore } from '@/stores/hermes';
import type { HermesConversation } from '@/stores/hermes';
import { setup } from './helpers';

const wrappers: VueWrapper[] = [];
const VIEWPORT = 300;

beforeEach(() => {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

async function transcript() {
  const { pinia, router } = await setup('/assistant');
  const wrapper = shallowMount(AssistantPage, {
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body
  });
  wrappers.push(wrapper);
  await flushPromises();
  const store = useHermesStore();
  const box = scrollBox(wrapper);
  store.conversations.splice(0, store.conversations.length);
  store.conversations.push({
    id: 'scroll-chat',
    messages: [{ id: 'assistant-1', role: 'assistant', text: 'first token', streaming: true, at: 1 }],
    updatedAt: 1
  });
  store.activeId = 'scroll-chat';
  await flushPromises();
  return { wrapper, store, box };
}

function addConversation(store: ReturnType<typeof useHermesStore>, id: string, text: string) {
  store.conversations.push({
    id,
    messages: [{ id: `${id}-message`, role: 'assistant', text, streaming: true, at: 2 }],
    updatedAt: 2
  } as HermesConversation);
}

/** jsdom has no layout: give the transcript a viewport, a content height and a real scrollTop. */
function scrollBox(wrapper: VueWrapper) {
  const element = wrapper.get<HTMLElement>('[data-hermes-transcript]').element;
  let top = 0;
  let height = 900;
  const bottom = () => Math.max(0, height - VIEWPORT);
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, bottom()));
    }
  });
  element.scrollTo = ((options?: ScrollToOptions | number) => {
    const target = typeof options === 'number' ? options : (options?.top ?? top);
    top = Math.max(0, Math.min(target, bottom()));
  }) as HTMLElement['scrollTo'];
  return {
    element,
    get top() {
      return top;
    },
    get bottom() {
      return bottom();
    },
    scrollTo(value: number) {
      top = Math.max(0, Math.min(value, bottom()));
      element.dispatchEvent(new Event('scroll'));
    },
    grow(px: number) {
      height += px;
    },
    setHeight(px: number) {
      height = px;
    }
  };
}

/** Queue animation frames so a test can decide when a pending tail scroll actually runs. */
function deferredFrames() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  return {
    pending: () => queue.length,
    flush() {
      while (queue.length) {
        const due = queue;
        queue = [];
        due.forEach(callback => callback(0));
      }
    }
  };
}

describe('Hermes transcript auto-scroll', () => {
  it('Keeps following a streaming turn while the reader is at the end', async () => {
    const { store, box } = await transcript();
    box.scrollTo(box.bottom);

    store.messages[0]!.text = 'first token and more';
    box.grow(120);
    await flushPromises();

    expect(box.top).toBe(box.bottom);
  });

  it('Leaves the reader alone after scrolling up during a streaming turn', async () => {
    const { store, box } = await transcript();
    box.scrollTo(box.bottom);
    box.scrollTo(120);

    store.messages[0]!.text = 'first token and more';
    box.grow(120);
    await flushPromises();
    store.thinking = true;
    await flushPromises();
    store.thinking = false;
    await flushPromises();

    expect(box.top).toBe(120);
  });

  it('Resumes following once the reader scrolls back to the end', async () => {
    const { store, box } = await transcript();
    box.scrollTo(120);

    box.scrollTo(box.bottom);
    store.messages[0]!.text = 'first token and more';
    box.grow(120);
    await flushPromises();

    expect(box.top).toBe(box.bottom);
  });

  it('Still jumps to the end when the reader sends a message', async () => {
    const { wrapper, store, box } = await transcript();
    const send = vi.spyOn(store, 'send').mockResolvedValue(undefined);
    box.scrollTo(120);

    await wrapper.get<HTMLTextAreaElement>('#hermes-composer').setValue('hello');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(send).toHaveBeenCalledWith('hello', []);
    expect(box.top).toBe(box.bottom);
  });

  it('Drops a queued tail scroll when the reader scrolls up before the frame runs', async () => {
    const frames = deferredFrames();
    const { store, box } = await transcript();
    frames.flush();
    box.scrollTo(box.bottom);
    frames.flush();

    store.messages[0]!.text = 'first token and more';
    box.grow(120);
    await flushPromises();
    expect(frames.pending()).toBe(1);

    // The reader moves before the queued frame writes: the frame must not fight them.
    box.scrollTo(120);
    frames.flush();
    expect(box.top).toBe(120);

    store.messages[0]!.text = 'first token and even more';
    box.grow(80);
    await flushPromises();
    store.thinking = true;
    await flushPromises();
    store.thinking = false;
    await flushPromises();
    frames.flush();

    expect(frames.pending()).toBe(0);
    expect(box.top).toBe(120);
  });

  it('Lands on the newest row when opening another conversation while off the tail', async () => {
    const { wrapper, store, box } = await transcript();
    box.scrollTo(box.bottom);
    box.scrollTo(120);
    addConversation(store, 'scroll-chat-long', 'a much longer answer');
    box.setHeight(2400);

    wrapper.findComponent(AssistantHistory).vm.$emit('select', 'scroll-chat-long');
    await flushPromises();

    expect(store.activeId).toBe('scroll-chat-long');
    expect(box.top).toBe(box.bottom);

    // The opened conversation is still streaming: its growth stays in view.
    store.messages[0]!.text = 'a much longer answer and more';
    box.grow(200);
    await flushPromises();
    expect(box.top).toBe(box.bottom);

    // Until the reader scrolls up again.
    box.scrollTo(box.bottom - 400);
    const reading = box.top;
    store.messages[0]!.text = 'a much longer answer and even more';
    box.grow(200);
    await flushPromises();
    expect(box.top).toBe(reading);
  });

  it('Lands on the newest row when a notification opens its conversation', async () => {
    const { store, box } = await transcript();
    box.scrollTo(120);
    addConversation(store, 'scroll-chat-long', 'a much longer answer');
    box.setHeight(2400);

    queueHermesNotificationOpen({ conversationId: 'scroll-chat-long' });
    await flushPromises();

    expect(store.activeId).toBe('scroll-chat-long');
    expect(box.top).toBe(box.bottom);
  });
});
