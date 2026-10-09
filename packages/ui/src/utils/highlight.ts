// Highlighted text (08 §8.34): recognize only **…**, preserving other characters as text without Markdown/HTML parsing.

export interface HighlightPart {
  text: string;
  strong: boolean;
}

export function parseHighlight(input: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ text: input.slice(cursor, match.index), strong: false });
    parts.push({ text: match[1] as string, strong: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) parts.push({ text: input.slice(cursor), strong: false });
  return parts;
}
