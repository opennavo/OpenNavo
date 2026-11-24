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
  const editor = wrapper.get<HTMLElement>('#hermes-composer');
  return { send, editor };
}

/** jsdom has no layout engine, so report the height a real editor would measure. */
function contentHeight(element: HTMLElement, height: number) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
}

type EditorWrapper = Omit<DOMWrapper<HTMLElement>, 'exists'>;

async function type(editor: EditorWrapper, text: string) {
  editor.element.textContent = text;
  await editor.trigger('input');
  await flushPromises();
}

describe('Hermes composer autosize', () => {
  it('Grows to fit a wrapped draft instead of keeping a one-row scrollbar', async () => {
    const { editor } = await mountComposer();
    contentHeight(editor.element, 84);

    await type(editor, '第一行\n第二行\n第三行');
    await flushPromises();

    expect(editor.element.style.height).toBe('84px');
    expect(editor.element.style.overflowY).toBe('hidden');
  });

  it('Keeps up with the draft while an IME composition is still open', async () => {
    const { editor } = await mountComposer();
    const element = editor.element;
    contentHeight(element, 42);
    await type(editor, '第一行');
    expect(element.style.height).toBe('42px');

    // The placeholder is held back during composition, but the box must not clip the pre-edit
    // text while the candidate window is still open.
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    contentHeight(element, 75);
    element.textContent = '第一行\n第二行';
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
    const { editor } = await mountComposer();
    contentHeight(editor.element, 300);

    await type(editor, Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
    await flushPromises();

    expect(editor.element.style.height).toBe('110px');
    expect(editor.element.style.overflowY).toBe('auto');
  });

  it('Collapses back to one row when sending clears the draft', async () => {
    const { send, editor } = await mountComposer();
    contentHeight(editor.element, 300);
    await type(editor, 'a long\ndraft');
    expect(editor.element.style.height).toBe('110px');

    contentHeight(editor.element, 42);
    await editor.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(send).toHaveBeenCalled();
    expect(editor.element.style.height).toBe('42px');
    expect(editor.element.style.overflowY).toBe('hidden');
  });
});
