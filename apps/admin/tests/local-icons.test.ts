import { readdirSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { Icon } from '@iconify/vue';
import SvgIcon from '../src/components/custom/svg-icon.vue';
import { localIcons } from '../src/components/custom/local-icons';
import { interfaceIcons } from '../src/components/custom/interface-icons';

describe('compiled local icons', () => {
  it('renders fixed interface icons with external requests blocked, including header variants and route icons', () => {
    expect(Object.keys(interfaceIcons)).toEqual(
      expect.arrayContaining([
        'line-md:menu-fold-left',
        'line-md:menu-fold-right',
        'heroicons:language',
        'material-symbols:sunny',
        'material-symbols:nightlight-rounded',
        'material-symbols:hdr-auto',
        'majesticons:color-swatch-line',
        'ph:user-circle',
        'ph:sign-out',
        'lucide:user-round',
        'lucide:menu',
        'lucide:settings'
      ])
    );
    const fetch = vi.fn(() => Promise.reject(new Error('Blocked by production CSP')));
    vi.stubGlobal('fetch', fetch);
    try {
      for (const icon of Object.keys(interfaceIcons)) {
        const wrapper = mount(SvgIcon, { props: { icon }, attrs: { class: 'test-icon', style: 'font-size: 20px' } });
        expect(wrapper.findComponent(Icon).exists(), icon).toBe(false);
        const svg = wrapper.get('svg');
        expect(svg.element.children.length, icon).toBeGreaterThan(0);
        expect(svg.classes()).toContain('test-icon');
        expect(svg.attributes('style')).toContain('font-size: 20px');
        expect(svg.attributes('aria-hidden')).toBe('true');
        wrapper.unmount();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps explicit local icons ahead of bundled interface icons', () => {
    const wrapper = mount(SvgIcon, { props: { icon: 'ph:user-circle', localIcon: 'avatar' } });
    expect(wrapper.findComponent(localIcons.avatar).exists()).toBe(true);
    expect(wrapper.findComponent(interfaceIcons['ph:user-circle']).exists()).toBe(false);
  });

  it('covers every repository SVG and renders without the removed sprite plugin', () => {
    const names = readdirSync('src/assets/svg-icon')
      .filter(name => name.endsWith('.svg'))
      .map(name => name.slice(0, -4));
    expect(Object.keys(localIcons).sort()).toEqual(names.sort());
    for (const name of names) {
      const wrapper = mount(SvgIcon, { props: { localIcon: name }, attrs: { class: 'test-icon' } });
      expect(wrapper.find('svg').exists()).toBe(true);
      expect(wrapper.find('svg').classes()).toContain('test-icon');
      expect(wrapper.find('use').exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it('falls back for missing names, including object prototype property names', () => {
    expect(mount(SvgIcon).findComponent(localIcons['no-icon']).exists()).toBe(true);
    for (const localIcon of ['missing-icon', '__proto__', 'constructor']) {
      const wrapper = mount(SvgIcon, { props: { localIcon } });
      expect(wrapper.findComponent(localIcons['no-icon']).exists()).toBe(true);
      wrapper.unmount();
    }
  });
});
