import { readdirSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SvgIcon from '../src/components/custom/svg-icon.vue';
import { localIcons } from '../src/components/custom/local-icons';

describe('compiled local icons', () => {
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
