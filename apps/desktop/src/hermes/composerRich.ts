/**
 * Reference-aware helpers for the Hermes composer.
 *
 * The official desktop turns pasted links and `@path` tokens into inline chips and serializes
 * them back to `@kind:`value`` when the prompt is submitted. The backend resolves that syntax,
 * so the chip is presentation only: the text on the wire is the same directive a user could type.
 */
import { getIcon } from '@opennavo/ui';

export type ComposerRefKind = 'file' | 'folder' | 'url' | string;

export interface ComposerTextPart {
  type: 'text';
  text: string;
}

export interface ComposerRefPart {
  type: 'ref';
  kind: ComposerRefKind;
  value: string;
}

export type ComposerPart = ComposerTextPart | ComposerRefPart;

export const COMPOSER_REF_CLASS = 'hermes-ref-chip';

/** Mirror the official renderer's reference vocabulary so stored prompts round-trip unchanged. */
const REFERENCE_PATTERN = /@(file|folder|url|image|tool|line|terminal|session):(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/;

export function referenceRe(): RegExp {
  return new RegExp(REFERENCE_PATTERN.source, 'g');
}

function needsQuoting(value: string): boolean {
  return /[\s()[\]{}<>"'`]/.test(value);
}

/** Quote a value only when the reference grammar needs it. */
export function formatRefValue(value: string): string {
  if (!needsQuoting(value)) return value;
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return value;
}

/** Chips always carry a fence so a following character cannot be re-absorbed into the value. */
export function quoteRefValue(value: string): string {
  if (!value.includes('`')) return `\`${value}\``;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return formatRefValue(value);
}

export function unwrapRefValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote && quote === value.at(-1) && ['`', '"', "'"].includes(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Split finished text into prose and references. */
export function parseRefText(text: string): ComposerPart[] {
  if (!text) return [];
  const parts: ComposerPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(referenceRe())) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ type: 'text', text: text.slice(cursor, start) });
    parts.push({ type: 'ref', kind: match[1] ?? 'file', value: unwrapRefValue(match[2] ?? '') });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts.length ? parts : [{ type: 'text', text }];
}

function isBlockElement(element: HTMLElement): boolean {
  return element.tagName === 'DIV' || element.tagName === 'P' || element.tagName === 'LI';
}

function serializeChildren(node: Node): string {
  let out = '';

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as HTMLElement;
    if (element.dataset.refText) {
      out += element.dataset.refText;
      continue;
    }
    if (element.tagName === 'BR') {
      out += '\n';
      continue;
    }
    if (isBlockElement(element)) {
      // Contenteditable uses block wrappers for Shift+Enter in some engines. A block starts a
      // line: insert the break it implies, and close the line unless its content already did.
      if (out && !out.endsWith('\n')) out += '\n';
      out += serializeChildren(element);
      if (!out.endsWith('\n')) out += '\n';
      continue;
    }
    out += serializeChildren(element);
  }

  return out;
}

/** The prompt text an editor's DOM represents. */
export function composerPlainText(editor: Node): string {
  const text = serializeChildren(editor);
  // A trailing block wrapper closes with a newline the user never typed; an explicit trailing
  // <br> is a pasted newline and must survive into the prompt.
  const last = editor.lastChild;
  const blockClosed = last?.nodeType === Node.ELEMENT_NODE && isBlockElement(last as HTMLElement);
  return blockClosed && text.endsWith('\n') ? text.slice(0, -1) : text;
}

interface TextRange {
  start: number;
  end: number;
}

function rangesFor(text: string, pattern: RegExp): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function insideRanges(ranges: TextRange[], index: number): boolean {
  return ranges.some(range => index >= range.start && index < range.end);
}

const FENCED_CODE_RE = /(```|~~~)[^\n]*\n[\s\S]*?\1/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const MARKDOWN_LINK_DESTINATION_RE = /\]\([^)\n]*\)/g;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,;:!?'"】》。，；：！？、]/;

function trimUrlTail(raw: string): string {
  let url = raw;
  while (url) {
    const last = url.at(-1) ?? '';
    if (TRAILING_URL_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    // Keep a closing parenthesis only when the URL opened one (Wikipedia-style paths).
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    if ((last === ']' || last === '}') && !url.includes(last === ']' ? '[' : '{')) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

function hasHttpHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function protectedRanges(text: string): TextRange[] {
  return [
    ...rangesFor(text, referenceRe()),
    ...rangesFor(text, FENCED_CODE_RE),
    ...rangesFor(text, INLINE_CODE_RE),
    ...rangesFor(text, MARKDOWN_LINK_DESTINATION_RE)
  ];
}

/** Rewrite bare http(s) links as `@url:` directives, leaving code, links and existing refs alone. */
export function linkifyUrls(text: string): string {
  if (!text.includes('http://') && !text.includes('https://')) return text;
  const ranges = protectedRanges(text);
  let out = '';
  let cursor = 0;

  for (const match of text.matchAll(new RegExp(URL_RE.source, 'gi'))) {
    const start = match.index ?? 0;
    if (insideRanges(ranges, start)) continue;
    const url = trimUrlTail(match[0]);
    if (!url || !hasHttpHost(url)) continue;

    out += `${text.slice(cursor, start)}@url:${quoteRefValue(url)}`;
    cursor = start + url.length;
  }

  return out + text.slice(cursor);
}

const BARE_PATH_RE =
  /(^|[\s(（"“'[,;:])@((?!(?:file|folder|url|image|tool|line|terminal|session):)[^\s@:`]*\/[^\s@:`]*)/g;

function barePathRef(path: string): { kind: 'file' | 'folder'; value: string } | null {
  const value = path.replace(/\/+$/, '');
  if (!value) return null;
  return { kind: path.endsWith('/') ? 'folder' : 'file', value };
}

/** Promote bare `@a/b` tokens to typed file/folder references (pasted text only). */
export function pathifyRefs(text: string): string {
  if (!text.includes('@')) return text;
  // Paths obey the same guards as links: code, Markdown destinations and existing refs are
  // prose, not a place to rewrite `@a/b`.
  const ranges = protectedRanges(text);
  let out = '';
  let cursor = 0;

  for (const match of text.matchAll(new RegExp(BARE_PATH_RE.source, 'g'))) {
    const start = match.index ?? 0;
    const tokenStart = start + (match[1]?.length ?? 0);
    if (insideRanges(ranges, tokenStart)) continue;
    // Sentence punctuation after a bare path belongs to the sentence, like a URL's trailing `.`
    // or `)`. Only the path itself is rewritten; the punctuation is re-emitted from the source.
    const path = trimUrlTail(match[2] ?? '');
    const ref = barePathRef(path);
    if (!ref) continue;

    out += `${text.slice(cursor, tokenStart)}@${ref.kind}:${quoteRefValue(ref.value)}`;
    cursor = tokenStart + 1 + path.length;
  }

  return out + text.slice(cursor);
}

/** The parts a paste inserts: prose with link and path chips. */
export function parsePastedText(text: string): ComposerPart[] {
  return parseRefText(pathifyRefs(linkifyUrls(text)));
}

export function isDataImageUrlText(text: string): boolean {
  return /^data:image\/[\w.+-]+;base64,/i.test(text.trim());
}

export function refChipLabel(kind: ComposerRefKind, value: string): string {
  if (kind === 'url') {
    try {
      const { hostname, pathname, search } = new URL(value);
      const path = `${pathname}${search}`.replace(/\/$/, '');
      return `${hostname.replace(/^www\./i, '')}${path}` || value;
    } catch {
      return value;
    }
  }
  return value.replace(/^\.\//, '') || value;
}

const REF_ICON: Record<string, string> = { url: 'globe', file: 'file', folder: 'folder' };

function appendIcon(chip: HTMLElement, kind: ComposerRefKind) {
  const icon = getIcon(REF_ICON[kind] ?? 'file');
  if (!icon) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', `0 0 ${icon.width} ${icon.height}`);
  svg.setAttribute('class', 'hermes-ref-chip-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = icon.body;
  chip.append(svg);
}

/** A non-editable chip whose `data-ref-text` is what the prompt actually carries. */
export function refChipElement(kind: ComposerRefKind, value: string, label?: string): HTMLElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.className = COMPOSER_REF_CLASS;
  chip.dataset.refKind = kind;
  chip.dataset.refId = value;
  chip.dataset.refText = `@${kind}:${quoteRefValue(value)}`;
  chip.title = value;
  appendIcon(chip, kind);
  chip.append(document.createTextNode(label || refChipLabel(kind, value)));
  return chip;
}

function appendTextWithBreaks(target: DocumentFragment | HTMLElement, text: string) {
  text.split('\n').forEach((line, index) => {
    if (index > 0) target.append(document.createElement('br'));
    if (line) target.append(document.createTextNode(line));
  });
}

export function partsFragment(parts: ComposerPart[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (part.type === 'ref') {
      fragment.append(refChipElement(part.kind, part.value));
    } else {
      appendTextWithBreaks(fragment, part.text);
    }
  }
  return fragment;
}

function caretRange(editor: HTMLElement): Range {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer)) return range;
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

function collapseAfter(editor: HTMLElement, node: Node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertByRange(editor: HTMLElement, parts: ComposerPart[]): Node | null {
  const range = caretRange(editor);
  range.deleteContents();
  const fragment = partsFragment(parts);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  return last;
}

/** Insert parts at the caret. Plain text uses the native command (undo stays intact); a chip
 *  is always a DOM insertion, because the native HTML command is free to rewrite its attributes. */
export function insertPartsAtCaret(editor: HTMLElement, parts: ComposerPart[]) {
  if (!parts.length) return;
  editor.focus();

  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.getRangeAt(0).startContainer)) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  const hasRefs = parts.some(part => part.type === 'ref');
  let inserted = false;
  if (!hasRefs && typeof document.execCommand === 'function') {
    const text = parts.map(part => (part.type === 'text' ? part.text : '')).join('');
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
  }

  if (!inserted) {
    const last = insertByRange(editor, parts);
    if (last) collapseAfter(editor, last);
  }

  normalizeEditorDom(editor);
}

/** Keep the placeholder marker in sync without touching the editable DOM (safe during IME). */
export function markEditorEmpty(editor: HTMLElement) {
  if (composerPlainText(editor).length === 0) {
    editor.dataset.empty = '';
  } else {
    delete editor.dataset.empty;
  }
}

/** Keep the placeholder marker and the browser's empty scaffolding in sync. */
export function normalizeEditorDom(editor: HTMLElement) {
  if (composerPlainText(editor).length === 0) {
    editor.replaceChildren();
  }
  markEditorEmpty(editor);
}

export function clearEditor(editor: HTMLElement) {
  editor.replaceChildren();
  editor.dataset.empty = '';
  editor.focus();
}

/** Text before a collapsed caret inside `editor`, with chips serialized back to their refs. */
export function textBeforeCaret(editor: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;

  const before = range.cloneRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);

  const holder = document.createElement('div');
  holder.append(before.cloneContents());
  return composerPlainText(holder);
}

function editableTextNodes(editor: HTMLElement): Text[] {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    // A chip's label is not editable text; never count it as part of a typed token.
    if (node.parentElement?.closest('[data-ref-text]')) continue;
    nodes.push(node);
  }
  return nodes;
}

/**
 * Replace the last `length` characters before a collapsed caret with `parts`. Text-manipulating
 * browsers (webkit) keep the editor's text nodes contiguous, so walking text nodes is enough;
 * returns false when the token would cross a chip or a block boundary.
 */
export function replaceBeforeCaret(editor: HTMLElement, length: number, parts: ComposerPart[]): boolean {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || selection.rangeCount === 0) return false;
  const caret = selection.getRangeAt(0);
  if (!editor.contains(caret.startContainer)) return false;
  if (caret.startContainer.nodeType !== Node.TEXT_NODE || caret.startOffset === 0) return false;

  const nodes = editableTextNodes(editor);
  let index = nodes.indexOf(caret.startContainer as Text);
  if (index < 0) return false;

  let remaining = length;
  let offset = caret.startOffset;
  while (remaining > 0) {
    const take = Math.min(offset, remaining);
    offset -= take;
    remaining -= take;
    if (remaining === 0) break;
    index -= 1;
    if (index < 0) return false;
    offset = nodes[index]?.textContent?.length ?? 0;
  }
  const startNode = nodes[index];
  if (!startNode || remaining > 0) return false;

  const replace = document.createRange();
  replace.setStart(startNode, offset);
  replace.setEnd(caret.startContainer, caret.startOffset);
  replace.deleteContents();

  const fragment = partsFragment(parts);
  const last = fragment.lastChild;
  replace.insertNode(fragment);
  if (last) collapseAfter(editor, last);
  normalizeEditorDom(editor);
  return true;
}

const TYPED_REF_AT_END = /(?:^|[\s(（"“'`[,;:])@(file|folder|url):(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)$/;
const TYPED_PATH_AT_END =
  /(?:^|[\s(（"“'`[,;:])@((?!(?:file|folder|url|image|tool|line|terminal|session):)[^\s@:]*\/[^\s@:]*)$/;

/** A typed reference the space key should commit as a chip. */
export function typedChipAtEnd(before: string): { tokenLength: number; kind: ComposerRefKind; value: string } | null {
  const ref = TYPED_REF_AT_END.exec(before);
  if (ref) {
    const tokenStart = ref[0].indexOf('@');
    return {
      tokenLength: ref[0].length - tokenStart,
      kind: ref[1] ?? 'file',
      value: unwrapRefValue(ref[2] ?? '')
    };
  }

  const path = TYPED_PATH_AT_END.exec(before);
  if (path) {
    const bare = barePathRef(path[1] ?? '');
    if (bare) {
      const tokenStart = path[0].indexOf('@');
      return { tokenLength: path[0].length - tokenStart, kind: bare.kind, value: bare.value };
    }
  }
  return null;
}
