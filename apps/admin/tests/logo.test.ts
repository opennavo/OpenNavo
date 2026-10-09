import { mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { LOGO, logoInlineShift } from '@opennavo/shared';
import SystemLogo from '../src/components/common/system-logo.vue';
import GlobalLogo from '../src/layouts/modules/global-logo/index.vue';
// Reuse the Vue component test environment to cover share-image entry points that bypass OnLogo.
import OgFrame from '../../web/app/components/og/OgFrame.vue';

vi.mock('@/store/modules/theme', () => ({ useThemeStore: () => ({ darkMode: true }) }));
vi.mock('@/locales', () => ({ $t: (key: string) => key }));

function mountLogo(showTitle: boolean) {
  return mount(GlobalLogo, {
    props: { showTitle },
    global: { components: { SystemLogo }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  });
}

it('raises the mark beside the title so the N centres on the text, but not when the sider is collapsed', () => {
  const shift = `transform: ${logoInlineShift(LOGO.small.nCenterOffset)}`;
  expect(mountLogo(true).get('svg').attributes('style')).toContain(shift);
  expect(mountLogo(false).get('svg').attributes('style')).toBeUndefined();
});

it.each([16, 32, 40])('selects geometry for a %i px admin logo', size => {
  const geometry = size <= 32 ? LOGO.small : LOGO;
  const svg = mount(SystemLogo, { props: { size, inline: true } }).get('svg');
  expect(svg.attributes('viewBox')).toBe(geometry.viewBox);
  expect(svg.findAll('path').map(path => path.attributes('d'))).toEqual([geometry.outerPath, geometry.innerPath]);
  expect(svg.attributes('style')).toContain(logoInlineShift(geometry.nCenterOffset));
});

it('uses SMALL geometry, tight viewBox and font-adjusted centering in the 32px OG footer', () => {
  const svg = mount(OgFrame, { props: { footer: 'OpenNavo' } }).get('svg');
  expect(svg.attributes('viewBox')).toBe(LOGO.small.markViewBox);
  expect(svg.attributes('width')).toBe(String(Math.round(32 * LOGO.small.markAspect)));
  expect(svg.attributes('height')).toBe('32');
  expect(svg.findAll('path').map(path => path.attributes('d'))).toEqual([LOGO.small.outerPath, LOGO.small.innerPath]);
  const shift = 32 * LOGO.small.nCenterOffset - ((1160 - 288 - 733) / 2000) * 24;
  expect(svg.attributes('style')).toContain(`translateY(-${shift.toFixed(2)}px)`);
});
