/**
 * Clipboard extraction rules shared by the composer paste handler and its tests.
 *
 * The official desktop reads images from `items`, falls back to `files`, then recognizes a
 * base64 `data:image` payload in the text, and finally inline `<img>` data URLs when the copy
 * carried no text of its own. Anything else is prose.
 */

/** Characters beyond which a plain-text paste becomes a `.txt` attachment. */
export const LARGE_PASTE_ATTACHMENT_THRESHOLD = 3_000;

/** Tiny inline images are decorations (spacers, trackers, blurhash placeholders), not files. */
const MIN_INLINE_IMAGE_BYTES = 4_096;

const DATA_IMAGE_URL_RE = /^data:image\/[\w.+-]+;base64,/i;
const INLINE_IMAGE_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["']/gi;

export function isDataImageUrlText(text: string): boolean {
  return DATA_IMAGE_URL_RE.test(text.trim());
}

export function shouldAttachPastedText(text: string): boolean {
  return text.length > LARGE_PASTE_ATTACHMENT_THRESHOLD;
}

/** UTF-8 size, the unit attachment limits are expressed in (never `string.length`). */
export function pastedTextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Human-readable UTF-8 size for the composer's pasted-content chip. */
export function pasteSizeLabel(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mime = match[1] ?? '';
  const encoded = match[3] ?? '';

  try {
    if (match[2]) {
      const binary = atob(encoded.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(encoded)], { type: mime });
  } catch {
    return null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read the image.')), {
      once: true
    });
    reader.readAsDataURL(blob);
  });
}

function blobDedupeKey(blob: Blob): string {
  if (blob instanceof File) {
    return `file:${blob.name}:${blob.size}:${blob.type}:${blob.lastModified}`;
  }
  return `blob:${blob.size}:${blob.type}`;
}

/**
 * Every image the paste carries, deduped. `items` and `files` often expose the same paste as
 * different objects, so identity alone is not enough.
 */
export function extractClipboardImages(clipboard: DataTransfer): Blob[] {
  const images: Blob[] = [];
  const seen = new Set<string>();

  const push = (blob: Blob | null) => {
    if (!blob || blob.size === 0) return;
    const key = blobDedupeKey(blob);
    if (seen.has(key)) return;
    seen.add(key);
    images.push(blob);
  };

  if (clipboard.items?.length) {
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        push(item.getAsFile());
      }
    }
  }

  if (!images.length && clipboard.files?.length) {
    for (const file of Array.from(clipboard.files)) {
      if (file.type.startsWith('image/')) push(file);
    }
  }

  if (images.length) return images;

  const text = clipboard.getData('text/plain').trim();
  if (DATA_IMAGE_URL_RE.test(text)) {
    push(dataUrlToBlob(text));
    return images;
  }

  // A rich-text copy with prose keeps its inline data URLs as page decoration: attaching the
  // placeholders while the text vanished was the "blank attachments, no message" bug.
  if (!text) {
    for (const match of clipboard.getData('text/html').matchAll(INLINE_IMAGE_SRC_RE)) {
      const blob = dataUrlToBlob(match[1] ?? '');
      if (blob && blob.size >= MIN_INLINE_IMAGE_BYTES) push(blob);
    }
  }

  return images;
}
