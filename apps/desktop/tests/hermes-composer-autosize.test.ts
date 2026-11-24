import { flushPromises, shallowMount } from '@vue/test-utils';
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPage from '@/pages/AssistantPage.vue';
import { i18n } from '@/i18n';
import { useHermesStore } from '@/stores/hermes';
import { setup } from './helpers';

const wrappers: VueWrapper[] = [];

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

async function mountComposer() {
  const { pinia, router } = await setup('/assistant');
  const wrapper = shallowMount(AssistantPage, {
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body
  });
  wrappers.push(wrapper);
  await flushPromises();
  const store = useHermesStore();
  const send = vi.spyOn(store, 'send').mockResolvedValue(undefined);
  const textarea = wrapper.get<HTMLTextAreaElement>('#hermes-composer');
  return { send, textarea };
}

/** jsdom has no layout engine, so report the height a real textarea would measure. */
function contentHeight(element: HTMLTextAreaElement, height: number) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
}

type TextareaWrapper = Omit<DOMWrapper<HTMLTextAreaElement>, 'exists'>;

async function type(textarea: TextareaWrapper, text: string) {
  await textarea.setValue(text);
  await flushPromises();
}

describe('Hermes composer autosize', () => {
  it('Grows to fit a wrapped draft instead of keeping a one-row scrollbar', async () => {
    const { textarea } = await mountComposer();
    contentHeight(textarea.element, 84);

    await type(textarea, '第一行\n第二行\n第三行');
    await flushPromises();

    expect(textarea.element.style.height).toBe('84px');
    expect(textarea.element.style.overflowY).toBe('hidden');
  });

  it('Keeps up with the draft while an IME composition is still open', async () => {
    const { textarea } = await mountComposer();
    const element = textarea.element;
    contentHeight(element, 42);
    await type(textarea, '第一行');
    expect(element.style.height).toBe('42px');

    // v-model ignores input events until compositionend, but the box must not clip the
    // pre-edit text while the candidate window is still open.
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    contentHeight(element, 75);
    element.value = '第一行\n第二行';
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '第二行',
        inputType: 'insertCompositionText',
        isComposing: true
      })
    );
    await flushPromises();

    expect(element.style.height).toBe('75px');
    expect(element.style.overflowY).toBe('hidden');
  });

  it('Caps the height and only then lets the draft scroll', async () => {
    const { textarea } = await mountComposer();
    contentHeight(textarea.element, 300);

    await type(textarea, Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
    await flushPromises();

    expect(textarea.element.style.height).toBe('110px');
    expect(textarea.element.style.overflowY).toBe('auto');
  });

  it('Collapses back to one row when sending clears the draft', async () => {
    const { send, textarea } = await mountComposer();
    contentHeight(textarea.element, 300);
    await type(textarea, 'a long\ndraft');
    expect(textarea.element.style.height).toBe('110px');

    contentHeight(textarea.element, 42);
    await textarea.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(send).toHaveBeenCalled();
    expect(textarea.element.style.height).toBe('42px');
    expect(textarea.element.style.overflowY).toBe('hidden');
  });
});
