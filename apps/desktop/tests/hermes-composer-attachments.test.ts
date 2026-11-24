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

async function composer() {
  const { pinia, router } = await setup('/assistant');
  const wrapper = shallowMount(AssistantPage, {
    global: { plugins: [pinia, router, i18n] },
    attachTo: document.body
  });
  wrappers.push(wrapper);
  await flushPromises();
  const store = useHermesStore();
  const send = vi.spyOn(store, 'send').mockResolvedValue(undefined);
  const textarea = wrapper.get<HTMLElement>('#hermes-composer');
  return { wrapper, store, send, textarea };
}

async function attachPhoto(wrapper: VueWrapper) {
  vi.spyOn(commands, 'hermesAttachmentInfo').mockResolvedValue([
    { path: '/tmp/photo.png', name: 'photo.png', size: 3, isImage: false }
  ]);
  await wrapper.get('button[aria-label="添加附件"]').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('photo.png');
}

function pressEnter(target: HTMLElement) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: 13 });
  target.dispatchEvent(event);
}

describe('Hermes composer attachments', () => {
  it('Keeps the text and files when the store cannot take an attachment send', async () => {
    const { wrapper, store, send, textarea } = await composer();
    await attachPhoto(wrapper);
    await setComposerText(wrapper, 'look at this');
    // Another turn owns the slot, or queued rows keep this chat waiting: the store rejects a
    // file send without writing a row, so the composer must keep everything the user selected.
    vi.spyOn(store, 'attachmentsBlocked').mockReturnValue(true);

    pressEnter(textarea.element);
    await flushPromises();

    expect(send).not.toHaveBeenCalled();
    expect(textarea.element.textContent).toBe('look at this');
    expect(wrapper.text()).toContain('photo.png');
  });

  it('Clears the composer once the attachment send is accepted', async () => {
    const { wrapper, store, send, textarea } = await composer();
    await attachPhoto(wrapper);
    await setComposerText(wrapper, 'look at this');
    vi.spyOn(store, 'attachmentsBlocked').mockReturnValue(false);

    pressEnter(textarea.element);
    await flushPromises();

    expect(send).toHaveBeenCalledWith('look at this', ['/tmp/photo.png']);
    expect(textarea.element.textContent).toBe('');
    expect(wrapper.text()).not.toContain('photo.png');
  });
});
