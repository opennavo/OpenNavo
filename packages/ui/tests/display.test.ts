import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import OnAppIcon from '../src/components/OnAppIcon.vue';
import OnBadge from '../src/components/OnBadge.vue';
import OnCard from '../src/components/OnCard.vue';
import OnChip from '../src/components/OnChip.vue';
import OnIcon from '../src/components/OnIcon.vue';
import OnStatTile from '../src/components/OnStatTile.vue';
import { ICON_PALETTE, LOGO, darken, fnv1a32, logoInlineShift } from '@opennavo/shared';

describe('OnIcon', () => {
  it('Renders built-in SVG icons synchronously and hides them from screen readers by default', () => {
    const wrapper = mount(OnIcon, { props: { name: 'search' } });
    const svg = wrapper.get('svg');
    expect(svg.attributes('aria-hidden')).toBe('true');
    expect(svg.attributes('width')).toBe('16');
    expect(svg.attributes('style')).toContain('--on-icon-stroke: 1.6');
  });

  it('Reads labeled icons as images and thickens strokes at small sizes', () => {
    const wrapper = mount(OnIcon, { props: { name: 'lucide:pin', label: '已固定', size: 12 } });
    const svg = wrapper.get('svg');
    expect(svg.attributes('role')).toBe('img');
    expect(svg.attributes('aria-label')).toBe('已固定');
    expect(svg.attributes('style')).toContain('--on-icon-stroke: 2');
  });

  it('Renders server-compatible SVG using bundled data and a 24-unit viewport', () => {
    const svg = mount(OnIcon, { props: { name: 'lucide:search' } }).get('svg');
    expect(svg.attributes('viewBox')).toBe('0 0 24 24');
    expect(svg.element.innerHTML).toContain('stroke="currentColor"');
    expect(svg.element.childElementCount).toBeGreaterThan(0);
  });

  it('Renders empty SVG and warns in development for missing bundled icons', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const svg = mount(OnIcon, { props: { name: 'lucide:definitely-missing' } }).get('svg');
    expect(svg.element.childElementCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('definitely-missing'));
    warn.mockRestore();
  });
});

describe('OnChip', () => {
  it.each([
    ['neutral', 'bg-surface-chip'],
    ['success', 'bg-status-success-subtle'],
    ['warning', 'bg-status-warning-subtle'],
    ['danger', 'bg-status-danger-subtle'],
    ['info', 'bg-status-info-subtle'],
    ['accent', 'bg-accent-salmon-subtle'],
    ['coral', 'bg-accent-coral-subtle']
  ] as const)('%s', (tone, expected) => {
    expect(mount(OnChip, { props: { tone }, slots: { default: 'x' } }).classes()).toContain(expected);
  });

  it('Supports stroke styles, dots, icons, and sizes', () => {
    const outline = mount(OnChip, { props: { tone: 'outline' }, slots: { default: '机器翻译' } });
    expect(outline.classes()).toEqual(expect.arrayContaining(['bg-transparent', 'border-line-default']));
    const dangerOutline = mount(OnChip, {
      props: { tone: 'danger', outline: true, size: 'md' },
      slots: { default: '已停用' }
    });
    expect(dangerOutline.classes()).toEqual(
      expect.arrayContaining(['on-chip-tinted-border', 'text-status-danger', 'h-24px'])
    );
    const withDot = mount(OnChip, { props: { tone: 'success', dot: true, icon: 'pin' }, slots: { default: '最新' } });
    expect(withDot.find('.rounded-full').exists()).toBe(true);
    expect(withDot.find('svg').exists()).toBe(true);
    expect(withDot.text()).toBe('最新');
  });
});

describe('OnBadge', () => {
  it('Caps count badges at 99+', () => {
    expect(mount(OnBadge, { props: { count: 6, label: '6 个可用更新' } }).attributes('aria-label')).toBe(
      '6 个可用更新'
    );
    expect(mount(OnBadge, { props: { count: 6 } }).text()).toBe('6');
    expect(mount(OnBadge, { props: { count: 120 } }).text()).toBe('99+');
    expect(mount(OnBadge, { props: { count: 12, max: 9 } }).text()).toBe('9+');
    expect(mount(OnBadge, { props: { count: -3 } }).text()).toBe('0');
  });

  it('Centers the optional North Star by its area centroid alongside badge text', () => {
    const wrapper = mount(OnBadge, { props: { star: true }, slots: { default: '本周精选' } });
    expect(wrapper.classes()).toContain('bg-accent-salmon-subtle');
    expect(wrapper.text()).toBe('本周精选');
    expect(wrapper.get('svg').attributes('viewBox')).toBe(LOGO.starViewBox);
    expect(wrapper.findAll('svg path')).toHaveLength(1);
    expect(wrapper.get('svg').attributes('style')).toContain(`transform: ${logoInlineShift(LOGO.starCenterOffset)}`);
    expect(
      mount(OnBadge, { slots: { default: '新版本' } })
        .find('svg')
        .exists()
    ).toBe(false);
  });
});

describe('OnCard', () => {
  it('Defaults to a noninteractive div', () => {
    const wrapper = mount(OnCard, { slots: { default: '内容' } });
    expect(wrapper.element.tagName).toBe('DIV');
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['bg-surface-card', 'rounded-big', 'p-16px']));
    expect(wrapper.classes()).not.toContain('cursor-pointer');
  });

  it('Renders href as a link and supplies button type', () => {
    const link = mount(OnCard, { props: { href: '/collections/new-mac', interactive: true, padding: 'lg' } });
    expect(link.element.tagName).toBe('A');
    expect(link.attributes('href')).toBe('/collections/new-mac');
    expect(link.classes()).toEqual(expect.arrayContaining(['cursor-pointer', 'p-18px']));
    const button = mount(OnCard, { props: { as: 'button', padding: 'none' } });
    expect(button.attributes('type')).toBe('button');
    expect(button.classes()).toContain('p-0');
    expect(mount(OnCard, { props: { as: 'section', padding: 'sm' } }).classes()).toContain('p-14px');
  });
});

describe('OnStatTile', () => {
  it('Displays labels, values, units, descriptions, and changes', () => {
    const wrapper = mount(OnStatTile, {
      props: {
        label: '磁盘占用',
        value: '18.6',
        unit: 'GB',
        hint: '含缓存 2.3 GB',
        delta: { value: '12%', direction: 'down', good: true }
      }
    });
    expect(wrapper.text()).toContain('磁盘占用');
    expect(wrapper.text()).toContain('18.6GB');
    expect(wrapper.text()).toContain('含缓存 2.3 GB');
    expect(wrapper.text()).toContain('↓ 12%');
    expect(wrapper.find('.text-status-success').exists()).toBe(true);
    expect(wrapper.classes()).toContain('bg-surface-card');
  });

  it('Omits the card background at medium size and uses danger color for deterioration', () => {
    const wrapper = mount(OnStatTile, {
      props: {
        label: '近 30 天安装',
        value: '17,394',
        size: 'md',
        delta: { value: '3%', direction: 'up', good: false }
      }
    });
    expect(wrapper.classes()).not.toContain('bg-surface-card');
    expect(wrapper.find('.text-status-danger').text()).toBe('↑ 3%');
  });
});

describe('OnAppIcon', () => {
  it('Lazy-loads icons and falls back to tiles after image failures', async () => {
    const wrapper = mount(OnAppIcon, {
      props: { kind: 'cask', token: 'ghostty', name: 'Ghostty', src: 'https://cdn.test/g.png' }
    });
    const img = wrapper.get('img');
    expect(img.attributes('loading')).toBe('lazy');
    await img.trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toBe('G');
    await wrapper.setProps({ src: 'https://cdn.test/g2.png' });
    expect(wrapper.find('img').exists()).toBe(true);
  });

  it('Falls back after mounting for SSR images that failed before hydration and retains successfully loaded images', async () => {
    const proto = HTMLImageElement.prototype;
    const original = {
      complete: Object.getOwnPropertyDescriptor(proto, 'complete'),
      naturalWidth: Object.getOwnPropertyDescriptor(proto, 'naturalWidth')
    };
    const stub = (complete: boolean, naturalWidth: number) => {
      Object.defineProperty(proto, 'complete', { configurable: true, get: () => complete });
      Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => naturalWidth });
    };
    try {
      stub(true, 0);
      const broken = mount(OnAppIcon, { props: { kind: 'cask', token: 'x', name: 'Xcode', src: '/missing.png' } });
      await broken.vm.$nextTick();
      expect(broken.find('img').exists()).toBe(false);
      expect(broken.text()).toBe('X');

      stub(true, 128);
      const loaded = mount(OnAppIcon, { props: { kind: 'cask', token: 'x', name: 'Xcode', src: '/icon.png' } });
      await loaded.vm.$nextTick();
      expect(loaded.find('img').exists()).toBe(true);
    } finally {
      for (const [key, descriptor] of Object.entries(original)) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
      }
    }
  });

  it('Uses a primary gradient, initial, and text at 42 percent of the side length for cask tiles', () => {
    const wrapper = mount(OnAppIcon, {
      props: { kind: 'cask', token: 'visual-studio-code', name: 'Visual Studio Code', accent: '#3C96F5', size: 64 }
    });
    const tile = wrapper.get('.on-letter-tile');
    expect(tile.text()).toBe('VS');
    expect(tile.attributes('style')).toContain('font-size: 27px');
    expect(tile.attributes('style')).toContain('--on-tile-from: #3C96F5');
    expect(tile.attributes('style')).toContain(`--on-tile-to: ${darken('#3C96F5')}`);
    expect(wrapper.attributes('style')).toContain('width: 64px');
    expect(wrapper.attributes('aria-hidden')).toBe('true');
  });

  it('Uses an abbreviation and hash-colored stripes for formula command-line tiles', () => {
    const wrapper = mount(OnAppIcon, {
      props: { kind: 'formula', token: 'ripgrep', name: 'ripgrep', size: 40, label: 'ripgrep' }
    });
    expect(wrapper.get('.on-cli-tile').text()).toBe('rg');
    expect(wrapper.attributes('role')).toBe('img');
    expect(wrapper.attributes('aria-label')).toBe('ripgrep');
    const expected = ICON_PALETTE[fnv1a32('ripgrep') % ICON_PALETTE.length] ?? '';
    const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(expected.slice(index, index + 2), 16));
    expect(wrapper.get('.on-cli-bar').attributes('style')).toContain(`rgb(${r}, ${g}, ${b})`);
  });
});
