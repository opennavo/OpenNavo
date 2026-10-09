/** Split values such as 18.6 GB or 5 minutes ago into number and unit for OnStatTile; if not number-prefixed, use the whole string as the value. */
export function splitValue(text: string): { value: string; unit?: string } {
  const match = /^([\d.,]+(?:[\u00a0\u202f]\d{3})*)\s*(.+)$/.exec(text);
  return match ? { value: match[1] ?? text, unit: match[2] } : { value: text };
}
