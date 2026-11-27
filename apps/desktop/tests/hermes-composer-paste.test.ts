import { flushPromises, shallowMount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { OnButton } from '@opennavo/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPage from '@/pages/AssistantPage.vue';
import { i18n } from '@/i18n';
import { commands } from '@/ipc/client';
import { useHermesStore } from '@/stores/hermes';
import { useToasts } from '@/composables/useToasts';
import { composerPlainText } from '@/hermes/composerRich';
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
  const editor = wrapper.get<HTMLElement>('#hermes-composer');
  return { wrapper, store, send, editor };
}

function clipboard({
  files = [] as File[],
  html = '',
  text = ''
}: { files?: File[]; html?: string; text?: string } = {}): DataTransfer {
  return {
    files: Object.assign(files.slice(), { item: (index: number) => files[index] ?? null }),
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file }))
  } as unknown as DataTransfer;
}

function paste(editor: { element: HTMLElement }, data: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: data });
  editor.element.dispatchEvent(event);
  return event;
}

function pressEnter(target: HTMLElement) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: 13 });
  target.dispatchEvent(event);
}

describe('Hermes composer paste', () => {
  it('turns a pasted link into a chip and submits the directive text', async () => {
    const { send, editor } = await composer();

    const event = paste(editor, clipboard({ text: 'read https://example.com/docs now' }));
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    const chip = editor.element.querySelector<HTMLElement>('.hermes-ref-chip');
    expect(chip).not.toBeNull();
    expect(chip?.dataset.refText).toBe('@url:`https://example.com/docs`');
    expect(chip?.textContent).toContain('example.com/docs');

    pressEnter(editor.element);
    await flushPromises();
    expect(send).toHaveBeenCalledWith('read @url:`https://example.com/docs` now', []);
  });

  it('turns a pasted @path into a file chip', async () => {
    const { send, editor } = await composer();

    paste(editor, clipboard({ text: 'open @apps/desktop/main.ts' }));
    await flushPromises();

    const chip = editor.element.querySelector<HTMLElement>('.hermes-ref-chip');
    expect(chip?.dataset.refText).toBe('@file:`apps/desktop/main.ts`');
    expect(chip?.dataset.refKind).toBe('file');

    pressEnter(editor.element);
    await flushPromises();
    expect(send).toHaveBeenCalledWith('open @file:`apps/desktop/main.ts`', []);
  });

  it('attaches a long paste as a .txt instead of flooding the composer', async () => {
    const { wrapper, send, editor } = await composer();
    const text = 'a'.repeat(3_001);
    const save = vi.spyOn(commands, 'hermesSavePastedText').mockResolvedValue({
      status: 'ok',
      data: {
        path: '/tmp/pasted-content.txt',
        name: 'pasted_content_20261124.txt',
        size: text.length,
        isImage: false
      }
    });

    paste(editor, clipboard({ text }));
    await flushPromises();

    expect(save).toHaveBeenCalledWith(text);
    expect(editor.element.textContent).toBe('');
    expect(wrapper.text()).toContain('粘贴内容');

    pressEnter(editor.element);
    await flushPromises();
    expect(send).toHaveBeenCalledWith('', ['/tmp/pasted-content.txt']);
  });

  it('keeps both the image and the text of a mixed paste', async () => {
    const { wrapper, editor } = await composer();
    const image = new File([new Uint8Array(8_192)], 'shot.png', { type: 'image/png' });
    const save = vi.spyOn(commands, 'hermesSaveAttachmentImage').mockResolvedValue({
      status: 'ok',
      data: {
        path: '/tmp/pasted-image.png',
        name: 'pasted-image.png',
        size: image.size,
        isImage: true
      }
    });

    paste(editor, clipboard({ files: [image], text: 'look at this' }));

    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await flushPromises();

    expect(editor.element.textContent).toBe('look at this');
    expect(wrapper.text()).toContain('pasted-image.png');
  });

  it('attaches a data:image paste without inserting the base64 text', async () => {
    const { editor } = await composer();
    const dataUrl = `data:image/png;base64,${btoa('x'.repeat(256))}`;
    const save = vi.spyOn(commands, 'hermesSaveAttachmentImage').mockResolvedValue({
      status: 'ok',
      data: {
        path: '/tmp/pasted-image.png',
        name: 'pasted-image.png',
        size: 256,
        isImage: true
      }
    });

    paste(editor, clipboard({ text: dataUrl }));

    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await flushPromises();

    expect(save.mock.calls[0]?.[0]).toBe(dataUrl);
    expect(editor.element.textContent).toBe('');
  });

  it('falls back to the native clipboard image when the paste carries nothing', async () => {
    const { wrapper, editor } = await composer();
    vi.spyOn(commands, 'hermesClipboardImage').mockResolvedValue({ status: 'ok', data: '/tmp/clipboard.png' });
    vi.spyOn(commands, 'hermesAttachmentInfo').mockResolvedValue([
      { path: '/tmp/clipboard.png', name: 'clipboard.png', size: 3, isImage: true }
    ]);

    paste(editor, clipboard());
    await vi.waitFor(() => expect(wrapper.text()).toContain('clipboard.png'));
  });

  it('commits a typed reference to a chip when the user types a space', async () => {
    const { wrapper, send } = await composer();
    const element = await setComposerText(wrapper, 'see @file:`apps/main.ts`');
    const range = document.createRange();
    const textNode = element.element.firstChild as Text;
    range.setStart(textNode, textNode.textContent?.length ?? 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    element.element.dispatchEvent(space);
    await flushPromises();

    expect(space.defaultPrevented).toBe(true);
    expect(element.element.querySelector('.hermes-ref-chip')?.getAttribute('data-ref-text')).toBe(
      '@file:`apps/main.ts`'
    );

    pressEnter(element.element);
    await flushPromises();
    // The space that committed the chip is real editor text and is sent unchanged.
    expect(send).toHaveBeenCalledWith('see @file:`apps/main.ts` ', []);
  });

  it('does not turn a bare @handle into a path chip', async () => {
    const { editor } = await composer();

    paste(editor, clipboard({ text: 'ask @teknium1 about it' }));
    await flushPromises();

    expect(editor.element.querySelector('.hermes-ref-chip')).toBeNull();
    expect(editor.element.textContent).toBe('ask @teknium1 about it');
  });

  it('keeps the indentation and trailing newline of a pasted block', async () => {
    const { editor } = await composer();
    const text = '  indented\n\tcode line\n';

    paste(editor, clipboard({ text }));
    await flushPromises();

    expect(composerPlainText(editor.element)).toBe(text);
  });

  it('discards a pasted file that settles after the page unmounts', async () => {
    const { wrapper, editor } = await composer();
    type SaveResult = Awaited<ReturnType<typeof commands.hermesSavePastedText>>;
    let releaseSave!: (value: SaveResult) => void;
    const save = vi.spyOn(commands, 'hermesSavePastedText').mockImplementation(
      () =>
        new Promise<SaveResult>(resolve => {
          releaseSave = resolve;
        })
    );
    const discard = vi.spyOn(commands, 'hermesDiscardAttachment').mockResolvedValue({ status: 'ok', data: null });

    paste(editor, clipboard({ text: 'a'.repeat(3_001) }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    const index = wrappers.indexOf(wrapper);
    if (index >= 0) wrappers.splice(index, 1);
    wrapper.unmount();

    // The save finishes after the draft/page is gone: the file this feature wrote is deleted
    // instead of being attached to whatever draft exists next.
    releaseSave({
      status: 'ok',
      data: {
        path: '/tmp/state/composer-pastes/late.txt',
        name: 'late.txt',
        size: 3_001,
        isImage: false
      }
    });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('/tmp/state/composer-pastes/late.txt'));
  });

  it('waits for a pasted attachment save before sending', async () => {
    const { send, editor } = await composer();
    type SaveResult = Awaited<ReturnType<typeof commands.hermesSavePastedText>>;
    let releaseSave!: (value: SaveResult) => void;
    const save = vi.spyOn(commands, 'hermesSavePastedText').mockImplementation(
      () =>
        new Promise<SaveResult>(resolve => {
          releaseSave = resolve;
        })
    );
    const text = 'a'.repeat(3_001);

    paste(editor, clipboard({ text }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    pressEnter(editor.element);
    await flushPromises();
    // The save owns the attachment; sending now would clear the composer under it.
    expect(send).not.toHaveBeenCalled();

    releaseSave({
      status: 'ok',
      data: {
        path: '/tmp/pasted-content.txt',
        name: 'pasted_content_20261124.txt',
        size: text.length,
        isImage: false
      }
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('', ['/tmp/pasted-content.txt']));
  });

  it('sends the pasted text and image together when the image save is still in flight', async () => {
    const { send, editor } = await composer();
    type ImageResult = Awaited<ReturnType<typeof commands.hermesSaveAttachmentImage>>;
    let releaseSave!: (value: ImageResult) => void;
    const image = new File([new Uint8Array(8_192)], 'shot.png', { type: 'image/png' });
    const save = vi.spyOn(commands, 'hermesSaveAttachmentImage').mockImplementation(
      () =>
        new Promise<ImageResult>(resolve => {
          releaseSave = resolve;
        })
    );

    paste(editor, clipboard({ files: [image], text: 'look at this' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    pressEnter(editor.element);
    await flushPromises();
    expect(send).not.toHaveBeenCalled();

    releaseSave({
      status: 'ok',
      data: { path: '/tmp/pasted-image.png', name: 'pasted-image.png', size: image.size, isImage: true }
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('look at this', ['/tmp/pasted-image.png']));
  });

  it('rejects an oversized paste instead of writing or inserting it', async () => {
    const { editor } = await composer();
    const save = vi.spyOn(commands, 'hermesSavePastedText');
    const discard = vi.spyOn(commands, 'hermesDiscardAttachment').mockResolvedValue({ status: 'ok', data: null });
    const text = 'a'.repeat(50 * 1024 * 1024 + 1);

    paste(editor, clipboard({ text }));
    await flushPromises();

    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(composerPlainText(editor.element)).toBe('');
    expect(useToasts().items.value.some(toast => toast.description?.includes('50 MB'))).toBe(true);
  });

  it('falls back to inline text only when the paste save really fails', async () => {
    const { editor } = await composer();
    vi.spyOn(commands, 'hermesSavePastedText').mockResolvedValue({
      status: 'error',
      error: { code: 'E_HERMES_PASTE', message: 'disk full', detail: null }
    });
    const text = 'code\n'.repeat(800);

    paste(editor, clipboard({ text }));
    await flushPromises();

    expect(composerPlainText(editor.element)).toBe(text);
  });

  it('deletes a managed paste file when its chip is removed', async () => {
    const { wrapper, editor } = await composer();
    const path = '/tmp/state/composer-pastes/pasted_content_1.txt';
    vi.spyOn(commands, 'hermesSavePastedText').mockResolvedValue({
      status: 'ok',
      data: { path, name: 'pasted_content_1.txt', size: 3_001, isImage: false }
    });
    const discard = vi.spyOn(commands, 'hermesDiscardAttachment').mockResolvedValue({ status: 'ok', data: null });

    paste(editor, clipboard({ text: 'a'.repeat(3_001) }));
    await flushPromises();
    await wrapper.get('button[aria-label="Remove pasted_content_1.txt"]').trigger('click');
    await flushPromises();

    expect(discard).toHaveBeenCalledWith(path);
  });

  it('never deletes a user-selected attachment when its chip is removed', async () => {
    const { wrapper } = await composer();
    vi.spyOn(commands, 'hermesAttachmentInfo').mockResolvedValue([
      { path: '/tmp/photo.png', name: 'photo.png', size: 3, isImage: false }
    ]);
    const discard = vi.spyOn(commands, 'hermesDiscardAttachment').mockResolvedValue({ status: 'ok', data: null });

    await wrapper.get('button[aria-label="添加附件"]').trigger('click');
    await flushPromises();
    await wrapper.get('button[aria-label="Remove photo.png"]').trigger('click');
    await flushPromises();

    expect(discard).not.toHaveBeenCalled();
  });

  it('sends the pasted indentation and trailing newline unchanged', async () => {
    const { send, editor } = await composer();
    const text = '  indented\ncode\n';

    paste(editor, clipboard({ text }));
    await flushPromises();
    pressEnter(editor.element);
    await flushPromises();

    expect(send).toHaveBeenCalledWith(text, []);
  });

  it('inserts a whitespace-only paste as text', async () => {
    const { editor } = await composer();
    const text = '  \n';

    paste(editor, clipboard({ text }));
    await flushPromises();

    expect(composerPlainText(editor.element)).toBe(text);
  });

  it('sends only once when Enter is pressed again while a paste save is pending', async () => {
    const { send, editor } = await composer();
    type SaveResult = Awaited<ReturnType<typeof commands.hermesSavePastedText>>;
    let releaseSave!: (value: SaveResult) => void;
    const save = vi.spyOn(commands, 'hermesSavePastedText').mockImplementation(
      () =>
        new Promise<SaveResult>(resolve => {
          releaseSave = resolve;
        })
    );
    const text = 'a'.repeat(3_001);

    paste(editor, clipboard({ text }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    pressEnter(editor.element);
    pressEnter(editor.element);
    await flushPromises();
    expect(send).not.toHaveBeenCalled();

    releaseSave({
      status: 'ok',
      data: { path: '/tmp/pasted-content.txt', name: 'pasted_content_2.txt', size: text.length, isImage: false }
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('discards managed paste files when starting a new chat', async () => {
    const { wrapper, editor } = await composer();
    const path = '/tmp/state/composer-pastes/pasted_content_3.txt';
    vi.spyOn(commands, 'hermesSavePastedText').mockResolvedValue({
      status: 'ok',
      data: { path, name: 'pasted_content_3.txt', size: 3_001, isImage: false }
    });
    const discard = vi.spyOn(commands, 'hermesDiscardAttachment').mockResolvedValue({ status: 'ok', data: null });

    paste(editor, clipboard({ text: 'a'.repeat(3_001) }));
    await flushPromises();
    wrapper
      .findAllComponents(OnButton)
      .find(button => button.props('icon') === 'lucide:plus')!
      .vm.$emit('click');
    await flushPromises();

    expect(discard).toHaveBeenCalledWith(path);
  });
});
