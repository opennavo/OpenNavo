import { readFileSync } from 'node:fs';
import { createGenerator, presetWind3 } from 'unocss';
import { describe, expect, it } from 'vitest';
import { buildArtifacts, collectCssVariables } from '../src/build.ts';
import type { JsonObject } from '../src/build.ts';
import { blendOver, contrastRatio } from '../src/contrast.ts';
import { color } from '../dist/tokens.ts';
import { adminColors, naiveDarkOverrides, naiveLightOverrides } from '../dist/naive-theme.ts';
import { presetOpenNavo } from '../dist/uno-preset.ts';

const root = new URL('..', import.meta.url);
const source = JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8')) as JsonObject;
const variables = collectCssVariables(source);
const variable = (name: string) => variables.find(item => item.name === name)?.value;

describe('Token artifacts', () => {
  it.each(Object.entries(buildArtifacts(source)))('Keeps dist/%s current', (file, content) => {
    expect(readFileSync(new URL(`dist/${file}`, root), 'utf8')).toBe(content);
  });
});

describe('CSS variable naming', () => {
  it('Matches the documented examples', () => {
    expect(variable('--on-surface-card-alt')).toBe('#1F1F1F');
    expect(variable('--on-text-tertiary')).toBe('#8F8F8F');
    expect(variable('--on-radius-big')).toBe('14px');
    expect(variable('--on-space-3-5')).toBe('14px');
    expect(variable('--on-surface-card')).toBe('#1A1A1A');
  });

  it('Uses unique names with the allowed prefix and characters', () => {
    const names = variables.map(item => item.name);
    for (const name of names) expect(name).toMatch(/^--on-[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('Exposes all colors as variables', () => {
    const colorGroups = source.color as Record<string, Record<string, unknown>>;
    for (const [group, entries] of Object.entries(colorGroups)) {
      for (const key of Object.keys(entries)) {
        const kebabKey = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        expect(variable(`--on-${group}-${kebabKey}`), `${group}.${key}`).toBeDefined();
      }
    }
  });

  it('Includes units for numeric values', () => {
    expect(variable('--on-typography-title1-size')).toBe('28px');
    expect(variable('--on-typography-title1-weight')).toBe('600');
    expect(variable('--on-motion-duration-fast')).toBe('120ms');
    expect(variable('--on-z-index-modal')).toBe('300');
    expect(variable('--on-radius-app-icon')).toBe('23%');
    expect(variable('--on-layout-desktop-traffic-light-inset-x')).toBe('18px');
  });

  it('Emits no placeholder CSS', () => {
    expect(variables.some(item => item.value.includes('{'))).toBe(false);
  });
});

// 08 §3.3 contrast table: foreground × background = documented value, one decimal place.
const surfaces = { base: color.surface.base, card: color.surface.card, raised: color.surface.raised };
const documented: Array<[string, string, [number, number, number]]> = [
  ['text.primary', color.text.primary, [15.9, 14.9, 12.9]],
  ['text.secondary', color.text.secondary, [7.8, 7.3, 6.4]],
  ['text.tertiary', color.text.tertiary, [5.7, 5.4, 4.7]],
  ['brand.coral', color.brand.coral, [6.9, 6.5, 5.6]],
  ['brand.salmon', color.brand.salmon, [9.0, 8.4, 7.3]],
  ['status.success', color.status.success, [9.2, 8.6, 7.5]],
  ['status.danger', color.status.danger, [6.1, 5.7, 5.0]],
  ['status.info', color.status.info, [7.3, 6.8, 5.9]],
  ['status.warning', color.status.warning, [10.1, 9.5, 8.2]]
];

describe('Contrast checks', () => {
  it.each(documented)(
    'Meets the documented 4.5 ratio for %s on all three backgrounds',
    (_name, foreground, expected) => {
      Object.values(surfaces).forEach((background, index) => {
        const ratio = contrastRatio(foreground, background);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
        expect(ratio).toBeCloseTo(expected[index] ?? 0, 1);
      });
    }
  );

  it('Button contrast', () => {
    const { button } = color;
    expect(contrastRatio(button.primaryText, button.primaryBg)).toBeCloseTo(15.5, 1);
    expect(contrastRatio(button.accentText, button.accentBg)).toBeCloseTo(7.2, 1);
    for (const background of [button.primaryBg, button.primaryHover, button.primaryPressed]) {
      expect(contrastRatio(button.primaryText, background)).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of [button.secondaryBg, button.secondaryHover, button.secondaryPressed]) {
      expect(contrastRatio(button.secondaryText, background)).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of [button.accentBg, button.accentHover, button.accentPressed]) {
      expect(contrastRatio(button.accentText, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Meets 4.6 for the admin light theme and uses onAccent in the dark theme', () => {
    expect(contrastRatio('#FFFFFF', adminColors.primaryLight)).toBeCloseTo(4.6, 1);
    expect(contrastRatio('#FFFFFF', adminColors.primaryDark)).toBeLessThan(4.5);
    expect(naiveDarkOverrides.Button?.textColorPrimary).toBe(color.text.onAccent);
    expect(contrastRatio(color.text.onAccent, adminColors.primaryDark)).toBeGreaterThanOrEqual(4.5);
  });

  it('Meets 4.5 for dark status text', () => {
    const statuses = [adminColors.info, adminColors.success, adminColors.warning, adminColors.error];
    for (const overrides of [naiveDarkOverrides, naiveLightOverrides]) {
      const text = String(overrides.Button?.textColorSuccess);
      for (const background of statuses) expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Meets 4.5 for badges on translucent backgrounds', () => {
  const pairs: Array<[string, string, string]> = [
    ['success', color.status.success, color.status.successSubtle],
    ['warning', color.status.warning, color.status.warningSubtle],
    ['danger', color.status.danger, color.status.dangerSubtle],
    ['info', color.status.info, color.status.infoSubtle],
    ['salmon', color.brand.salmon, color.accent.salmonSubtle],
    ['coral', color.brand.coral, color.accent.coralSubtle]
  ];
  it.each(pairs)('%s', (_name, text, subtle) => {
    for (const surface of [color.surface.base, color.surface.card, color.surface.cardAlt]) {
      expect(contrastRatio(text, blendOver(subtle, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Checks neutral and terminal text', () => {
    expect(contrastRatio(color.text.secondary, color.surface.chip)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(color.component.cliIconText, color.component.cliIconFrom)).toBeGreaterThanOrEqual(4.5);
  });

  it('Blends RGBA colors with blendOver', () => {
    expect(blendOver('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(() => blendOver('#FFFFFF', '#000000')).toThrow();
  });
});

describe('UnoCSS integration', () => {
  it('Generates token utilities', async () => {
    const generator = await createGenerator({ presets: [presetWind3(), presetOpenNavo()] });
    const { css } = await generator.generate(
      [
        'bg-surface-card-alt',
        'text-ink-tertiary',
        'border-line-subtle',
        'text-brand-coral',
        'bg-status-success-subtle',
        'rounded-big',
        'rounded-app-icon',
        'shadow-popover',
        'z-modal',
        'duration-fast',
        'ease-standard',
        'font-mono',
        'text-title1',
        'text-stat',
        'text-body-sm',
        'text-label',
        'text-mono',
        'bg-chart-series1',
        'text-chart-series3'
      ].join(' '),
      { preflights: false }
    );
    expect(css).toContain('.bg-surface-card-alt{background-color:var(--on-surface-card-alt);}');
    // Generate colors whose names end in digits, such as category colors, too.
    expect(css).toContain('.bg-chart-series1{background-color:var(--on-chart-series1);}');
    expect(css).toContain('.text-chart-series3{color:var(--on-chart-series3);}');
    expect(css).toContain('.text-ink-tertiary{color:var(--on-text-tertiary);}');
    expect(css).toContain('.border-line-subtle{border-color:var(--on-border-subtle);}');
    expect(css).toContain('.text-brand-coral{color:var(--on-brand-coral);}');
    expect(css).toContain('.bg-status-success-subtle{background-color:var(--on-status-success-subtle);}');
    expect(css).toContain('.rounded-big{border-radius:var(--on-radius-big);}');
    expect(css).toContain('.rounded-app-icon{border-radius:var(--on-radius-app-icon);}');
    expect(css).toContain('var(--on-shadow-popover)');
    expect(css).toContain('.z-modal{z-index:var(--on-z-index-modal);}');
    expect(css).toContain('.duration-fast{transition-duration:var(--on-motion-duration-fast);}');
    expect(css).toContain('.ease-standard{transition-timing-function:var(--on-motion-easing-standard);}');
    expect(css).toContain('.font-mono{font-family:var(--on-font-family-mono);}');
    expect(css).toContain(
      '.text-title1{font-size:var(--on-typography-title1-size);line-height:var(--on-typography-title1-line-height);font-weight:var(--on-typography-title1-weight);letter-spacing:var(--on-typography-title1-letter-spacing);}'
    );
    expect(css).toContain('.text-stat{font-size:var(--on-typography-stat-value-size);');
    expect(css).toContain('.text-body-sm{font-size:var(--on-typography-body-sm-size);');
    expect(css).toContain('text-transform:var(--on-typography-label-text-transform);');
    expect(css).toMatch(/\.text-mono\{[^}]*font-family:var\(--on-font-family-mono\);/);
  });
});

describe('Locale font stacks', () => {
  it('Prefers Japanese fonts while preserving the Chinese stack', () => {
    const css = buildArtifacts(source)['tokens.css'];
    expect(css).toContain(
      ':lang(ja) { --on-font-family-sans: "Inter Variable", Inter, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP"'
    );
    expect(css).toContain(':lang(zh) { --on-font-family-sans: "Inter Variable", Inter, "PingFang SC"');
    expect(naiveDarkOverrides.common?.fontFamily).toBe('var(--on-font-family-sans)');
  });
});
