import { describe, expect, it } from 'vitest';
import {
  composerPlainText,
  formatRefValue,
  linkifyUrls,
  parsePastedText,
  parseRefText,
  pathifyRefs,
  quoteRefValue,
  refChipElement,
  refChipLabel,
  typedChipAtEnd
} from '@/hermes/composerRich';
import {
  LARGE_PASTE_ATTACHMENT_THRESHOLD,
  dataUrlToBlob,
  extractClipboardImages,
  isDataImageUrlText,
  pasteSizeLabel,
  pastedTextBytes,
  shouldAttachPastedText
} from '@/hermes/composerClipboard';

function clipboard({
  files = [] as File[],
  html = '',
  items = [] as Array<{ kind: string; type: string; getAsFile: () => File | null }>,
  text = ''
} = {}): DataTransfer {
  return {
    files: Object.assign(files.slice(), { item: (index: number) => files[index] ?? null }),
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
    items
  } as unknown as DataTransfer;
}

function image(name = 'shot.png', type = 'image/png', size = 8_192): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('composer reference grammar', () => {
  it('quotes a value only when the grammar needs one', () => {
    expect(formatRefValue('apps/desktop/main.ts')).toBe('apps/desktop/main.ts');
    expect(formatRefValue('apps/my notes.md')).toBe('`apps/my notes.md`');
    expect(quoteRefValue('apps/desktop/main.ts')).toBe('`apps/desktop/main.ts`');
    expect(quoteRefValue('a`b')).toBe('"a`b"');
  });

  it('splits stored prompts into prose and references', () => {
    expect(parseRefText('see @url:`https://example.com/a?q=1` now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'ref', kind: 'url', value: 'https://example.com/a?q=1' },
      { type: 'text', text: ' now' }
    ]);
  });

  it('round-trips a chip through the editor DOM', () => {
    const editor = document.createElement('div');
    editor.append(document.createTextNode('look at '));
    editor.append(refChipElement('file', 'apps/desktop/main.ts'));
    editor.append(document.createElement('br'));
    editor.append(document.createTextNode('and this'));

    expect(composerPlainText(editor)).toBe('look at @file:`apps/desktop/main.ts`\nand this');
  });

  it('treats contenteditable block wrappers as line breaks', () => {
    const editor = document.createElement('div');
    editor.innerHTML = 'first<div>second</div>';
    expect(composerPlainText(editor)).toBe('first\nsecond');

    const lines = document.createElement('div');
    lines.innerHTML = '<div>one</div><div><br></div><div>three</div>';
    expect(composerPlainText(lines)).toBe('one\n\nthree');
  });

  it('labels chips without the scheme or www', () => {
    expect(refChipLabel('url', 'https://www.example.com/docs/')).toBe('example.com/docs');
    expect(refChipLabel('file', './apps/main.ts')).toBe('apps/main.ts');
  });
});

describe('pasted link and path refs', () => {
  it('turns bare http links into url chips', () => {
    expect(linkifyUrls('read https://example.com/docs now')).toBe('read @url:`https://example.com/docs` now');
  });

  it('leaves links inside code, Markdown destinations and existing refs alone', () => {
    const text = '`https://example.com/a` [x](https://example.com/b) @url:`https://example.com/c`';
    expect(linkifyUrls(text)).toBe(text);
  });

  it('promotes typed @paths to file and folder refs', () => {
    expect(pathifyRefs('open @apps/desktop/ please')).toBe('open @folder:`apps/desktop` please');
    expect(pathifyRefs('open @apps/desktop/main.ts')).toBe('open @file:`apps/desktop/main.ts`');
    expect(pathifyRefs('@user is not a path')).toBe('@user is not a path');
  });

  it('leaves paths inside code, Markdown destinations and existing refs alone', () => {
    const text = '`@apps/desktop/main.ts` [x](@apps/desktop/main.ts) @file:`apps/desktop/main.ts`';
    expect(pathifyRefs(text)).toBe(text);

    const fenced = '```\nopen @apps/desktop/main.ts\n```';
    expect(pathifyRefs(fenced)).toBe(fenced);
  });

  it('keeps sentence punctuation out of the file name', () => {
    expect(pathifyRefs('open @apps/desktop/main.ts.')).toBe('open @file:`apps/desktop/main.ts`.');
    expect(pathifyRefs('open (@apps/desktop/main.ts)')).toBe('open (@file:`apps/desktop/main.ts`)');
  });

  it('combines both rewriters for a mixed paste', () => {
    const parts = parsePastedText('@apps/main.ts and https://example.com');
    expect(parts).toEqual([
      { type: 'ref', kind: 'file', value: 'apps/main.ts' },
      { type: 'text', text: ' and ' },
      { type: 'ref', kind: 'url', value: 'https://example.com' }
    ]);
  });

  it('detects a typed ref at the caret for space-to-chip', () => {
    expect(typedChipAtEnd('see @file:`apps/main.ts`')).toEqual({
      tokenLength: '@file:`apps/main.ts`'.length,
      kind: 'file',
      value: 'apps/main.ts'
    });
    expect(typedChipAtEnd('see @apps/main.ts')).toEqual({
      tokenLength: '@apps/main.ts'.length,
      kind: 'file',
      value: 'apps/main.ts'
    });
    expect(typedChipAtEnd('plain words')).toBeNull();
  });
});

describe('clipboard image extraction', () => {
  it('prefers items, then files, and dedupes the same paste', () => {
    const file = image();
    const fromItems = clipboard({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] });
    expect(extractClipboardImages(fromItems)).toEqual([file]);

    const fromFiles = clipboard({ files: [file] });
    expect(extractClipboardImages(fromFiles)).toEqual([file]);
  });

  it('recognizes a base64 data:image payload in the text', () => {
    const dataUrl = `data:image/png;base64,${btoa('x'.repeat(32))}`;
    const blobs = extractClipboardImages(clipboard({ text: dataUrl }));

    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('image/png');
    expect(isDataImageUrlText(dataUrl)).toBe(true);
  });

  it('keeps inline HTML images only for an image-only copy', () => {
    const dataUrl = `data:image/png;base64,${btoa('x'.repeat(8_000))}`;
    const html = `<img src="${dataUrl}">`;

    expect(extractClipboardImages(clipboard({ html }))).toHaveLength(1);
    expect(extractClipboardImages(clipboard({ html, text: 'hello' }))).toHaveLength(0);
  });

  it('drops tiny inline decorations', () => {
    const dataUrl = `data:image/png;base64,${btoa('x')}`;
    expect(extractClipboardImages(clipboard({ html: `<img src="${dataUrl}">` }))).toHaveLength(0);
  });

  it('rejects malformed data URLs', () => {
    expect(dataUrlToBlob('not a data url')).toBeNull();
    expect(dataUrlToBlob('data:image/png;base64,***')).toBeNull();
  });
});

describe('large paste policy', () => {
  it('only converts pastes beyond the threshold', () => {
    expect(shouldAttachPastedText('a'.repeat(LARGE_PASTE_ATTACHMENT_THRESHOLD))).toBe(false);
    expect(shouldAttachPastedText('a'.repeat(LARGE_PASTE_ATTACHMENT_THRESHOLD + 1))).toBe(true);
  });

  it('labels sizes for the attachment chip', () => {
    expect(pasteSizeLabel('a'.repeat(512))).toBe('512 B');
    expect(pasteSizeLabel('a'.repeat(2_048))).toBe('2.0 KB');
  });

  it('measures attachment limits in UTF-8 bytes, not string length', () => {
    expect(pastedTextBytes('a')).toBe(1);
    expect(pastedTextBytes('界')).toBe(3);
    // Two CJK characters are 2 UTF-16 units but 6 bytes for a 5-byte limit.
    expect(pastedTextBytes('界界')).toBeGreaterThan(5);
  });
});
