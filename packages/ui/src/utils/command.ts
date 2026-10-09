// Long install commands (08 §8.19) wrap after --cask/--formula using a space/backslash and four-space indent, never inside tokens.

export function commandLines(command: string, wrapAt = 30): string[] {
  const text = command.trim();
  if (text.length <= wrapAt) return [text];
  const match = /^(.*?--(?:cask|formula))\s+(.+)$/.exec(text);
  if (!match) return [text];
  return [`${match[1]} \\`, `    ${match[2]}`];
}
