// Hero glow (08 §8.13): replace effect.heroGlow violet with supplied accent, preserving positions/opacity stops.
// Default stops approximate accent mixed 70% white / 27% white / unchanged / 25% black; derive the same ratios.

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Blend toward white (255) or black (0) by ratio. */
function mix(rgb: Rgb, toward: 0 | 255, amount: number): Rgb {
  return rgb.map(channel => Math.round(channel + (toward - channel) * amount)) as Rgb;
}

/** Return radial-gradient, or undefined for non-six-digit hex to retain default glow. */
export function heroGlowGradient(color: string | null | undefined): string | undefined {
  if (!color || !HEX_COLOR.test(color)) return undefined;
  const base = parse(color);
  const stops: [Rgb, number, number][] = [
    [mix(base, 255, 0.7), 0.95, 0],
    [mix(base, 255, 0.27), 0.78, 14],
    [base, 0.5, 32],
    [mix(base, 0, 0.25), 0.2, 52]
  ];
  const parts = stops.map(([rgb, alpha, at]) => `rgba(${rgb.join(', ')}, ${alpha}) ${at}%`);
  return `radial-gradient(circle, ${parts.join(', ')}, transparent 70%)`;
}
