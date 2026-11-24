import type { Ref } from 'vue';
import { isDataImageUrlText, shouldAttachPastedText, extractClipboardImages } from '@/hermes/composerClipboard';
import {
  clearEditor,
  composerPlainText,
  insertPartsAtCaret,
  markEditorEmpty,
  parsePastedText,
  replaceBeforeCaret,
  textBeforeCaret,
  typedChipAtEnd,
  type ComposerPart
} from '@/hermes/composerRich';

/** What happened to the text a paste handed to `attachPastedText`. */
export type PastedTextOutcome = 'attached' | 'rejected' | 'failed';

export interface HermesComposerEditorOptions {
  editor: Ref<HTMLElement | null>;
  /** The serialized prompt text the rest of the page uses for submit gating and sending. */
  value: Ref<string>;
  /** Add pasted image blobs to the composer's attachment row. */
  attachImages: (blobs: Blob[]) => Promise<void> | void;
  /**
   * Persist a large paste as a `.txt` attachment. `rejected` means the paste is too large to
   * attach or insert; `failed` is a real write/IPC failure, which falls back to inline text.
   */
  attachPastedText: (text: string) => Promise<PastedTextOutcome>;
  /** Native clipboard image fallback for platforms whose paste event carries no image file. */
  attachClipboardImage: () => Promise<boolean>;
  /** True while an IME composition owns the keyboard, so a Space keypress is not a chip commit. */
  isComposing?: () => boolean;
}

/**
 * Contenteditable controller for the Hermes composer: keeps the serialized value in sync,
 * renders pasted links/paths as chips, and routes large text and images to attachments.
 */
export function useHermesComposerEditor(options: HermesComposerEditorOptions) {
  /** Saves started by paste. A send waits for these so its attachment list is complete. */
  const pendingPastes = new Set<Promise<unknown>>();

  function track<T>(task: Promise<T> | void) {
    if (!task) return;
    pendingPastes.add(task);
    void task.then(
      () => pendingPastes.delete(task),
      () => pendingPastes.delete(task)
    );
  }

  /** Resolve once every attachment a paste started has landed (or failed). */
  async function whenPasteSettled() {
    while (pendingPastes.size) {
      await Promise.allSettled(pendingPastes);
    }
  }

  function syncFromDom() {
    const editor = options.editor.value;
    if (!editor) return;
    options.value.value = composerPlainText(editor);
    // During composition the empty plain text is preedit scaffolding, not an empty draft:
    // the placeholder must stay hidden until compositionend syncs the real content.
    if (!options.isComposing?.()) markEditorEmpty(editor);
  }

  function clear() {
    const editor = options.editor.value;
    if (!editor) {
      options.value.value = '';
      return;
    }
    clearEditor(editor);
    options.value.value = '';
  }

  function focus() {
    options.editor.value?.focus();
  }

  function getPlainText() {
    syncFromDom();
    return options.value.value;
  }

  function insertText(text: string) {
    const editor = options.editor.value;
    if (!editor || !text) return;
    insertPartsAtCaret(editor, parsePastedText(text));
    syncFromDom();
  }

  /**
   * Handle a clipboard payload. Returns true when the composer consumed it, so a window-level
   * listener can prevent the browser's default paste outside the editor.
   */
  function handleClipboard(clipboard: DataTransfer): boolean {
    const editor = options.editor.value;
    if (!editor) return false;

    const images = extractClipboardImages(clipboard);
    // Keep the raw text: trim() may only decide whether the paste has substance. Inserted and
    // saved text keeps its indentation, leading spaces and trailing newline.
    const text = clipboard.getData('text/plain');
    const hasText = text.trim().length > 0;

    if (!images.length && !hasText) {
      // A whitespace-only paste is still raw text; only a paste that carried no text at all goes
      // to the native reader (WKWebView may not expose the host screenshot as a clipboard file).
      if (text) insertText(text);
      else track(options.attachClipboardImage());
      return true;
    }

    if (images.length) track(options.attachImages(images));

    if (!hasText) {
      if (text) insertText(text);
      return true;
    }

    // The data URL in the text IS the image attached above; inserting it as prose would send
    // a wall of base64 alongside the attachment.
    if (images.length && isDataImageUrlText(text)) return true;

    if (shouldAttachPastedText(text)) {
      track(
        options.attachPastedText(text).then(result => {
          // A rejected paste is too large to attach AND too large to insert; only a real write
          // failure may fall back to inline text.
          if (result === 'failed') insertText(text);
        })
      );
      return true;
    }

    insertText(text);
    return true;
  }

  function onPaste(event: ClipboardEvent) {
    const clipboard = event.clipboardData;
    if (!clipboard || !options.editor.value) return;
    event.preventDefault();
    handleClipboard(clipboard);
  }

  function onInput() {
    syncFromDom();
  }

  /** Space commits a typed `@kind:`…`` (or bare `@path`) into a chip, like the official editor. */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing || options.isComposing?.()) return;
    const editor = options.editor.value;
    if (!editor) return;

    const selection = window.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return;
    const caret = selection.getRangeAt(0);
    if (caret.startContainer.nodeType !== Node.TEXT_NODE || caret.startOffset === 0) return;

    const before = textBeforeCaret(editor);
    if (!before?.includes('@')) return;
    const chip = typedChipAtEnd(before);
    if (!chip) return;

    const parts: ComposerPart[] = [
      { type: 'ref', kind: chip.kind, value: chip.value },
      { type: 'text', text: ' ' }
    ];
    if (!replaceBeforeCaret(editor, chip.tokenLength, parts)) return;
    event.preventDefault();
    syncFromDom();
  }

  return {
    clear,
    focus,
    getPlainText,
    handleClipboard,
    insertText,
    onInput,
    onKeydown,
    onPaste,
    syncFromDom,
    whenPasteSettled
  };
}
