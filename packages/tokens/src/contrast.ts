// WCAG 2.2 contrast calculations shared by tests and component examples.

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Only six-digit hexadecimal colors are supported: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** Composite rgba(r, g, b, a) over an opaque background, returning the displayed six-digit hex color. */
export function blendOver(rgba: string, background: string): string {
  const match = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(rgba);
  if (!match) throw new Error(`Only rgba() colors are supported: ${rgba}`);
  const [, r, g, b, a] = match.map(Number) as [number, number, number, number, number];
  const base = parseHex(background);
  const channels = [r, g, b].map((value, index) => Math.round(value * a + (base[index] ?? 0) * (1 - a)));
  return `#${channels
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}
