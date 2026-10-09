import { config as testConfig } from '@vue/test-utils';
import { ref as localeRef } from 'vue';
import { ON_UI_LOCALE as fixtureLocaleKey } from '../src/composables/locale';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import OnButton from '../src/components/OnButton.vue';
import OnGetButton from '../src/components/OnGetButton.vue';
import { RouterLinkStub, withLocale } from './helpers';

describe('OnButton', () => {
  it('Defaults to secondary and medium and emits clicks', async () => {
    const wrapper = mount(OnButton, { slots: { default: '打开' } });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.classes()).toEqual(expect.arrayContaining(['bg-button-secondary-bg', 'h-34px', 'rounded-default']));
    await button.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it.each([
    ['primary', 'bg-button-primary-bg'],
    ['accent', 'bg-button-accent-bg'],
    ['ghost', 'border-line-default'],
    ['danger', 'bg-status-danger-subtle']
  ] as const)('%s 变体', (variant, expected) => {
    const wrapper = mount(OnButton, { props: { variant }, slots: { default: 'x' } });
    expect(wrapper.get('button').classes()).toContain(expected);
  });

  it('Supports sizes, pill shape, and block layout', () => {
    const wrapper = mount(OnButton, { props: { size: 'xs', shape: 'round', block: true }, slots: { default: 'x' } });
    expect(wrapper.get('button').classes()).toEqual(expect.arrayContaining(['h-26px', 'rounded-full', 'w-full']));
  });

  it('Renders square icon buttons with accessible labels', () => {
    const wrapper = mount(OnButton, {
      props: { icon: 'lucide:copy', iconOnly: true, ariaLabel: '复制', size: 'sm' },
      slots: { default: '不显示' }
    });
    const button = wrapper.get('button');
    expect(button.attributes('aria-label')).toBe('复制');
    expect(button.classes()).toEqual(expect.arrayContaining(['h-28px', 'w-28px']));
    expect(button.text()).toBe('');
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('Disables buttons while loading', async () => {
    const loading = mount(OnButton, { props: { loading: true, variant: 'primary' }, slots: { default: '更新' } });
    expect(loading.get('button').attributes('disabled')).toBeDefined();
    expect(loading.get('button').attributes('aria-busy')).toBe('true');
    expect(loading.find('.on-spinner').exists()).toBe(true);
    expect(loading.get('button').classes()).toContain('bg-button-disabled-bg');
    expect(loading.get('button').classes()).not.toContain('bg-button-primary-bg');

    const disabled = mount(OnButton, { props: { disabled: true }, slots: { default: '卸载' } });
    await disabled.get('button').trigger('click');
    expect(disabled.emitted('click')).toBeUndefined();
  });

  it('Renders href links and removes navigation when disabled', async () => {
    const link = mount(OnButton, {
      props: { href: '/apps/ghostty', target: '_blank', rel: 'noopener' },
      slots: { default: '查看详情' }
    });
    const anchor = link.get('a');
    expect(anchor.attributes('href')).toBe('/apps/ghostty');
    expect(anchor.attributes('target')).toBe('_blank');
    await anchor.trigger('click');
    expect(link.emitted('click')).toHaveLength(1);

    const disabled = mount(OnButton, { props: { href: '/x', disabled: true }, slots: { default: 'x' } });
    expect(disabled.get('a').attributes('href')).toBeUndefined();
    expect(disabled.get('a').attributes('aria-disabled')).toBe('true');
    await disabled.get('a').trigger('click');
    expect(disabled.emitted('click')).toBeUndefined();
  });

  it('Supports router destinations', () => {
    const routed = mount(OnButton, {
      props: { href: '/apps/ghostty', linkAs: RouterLinkStub, variant: 'primary' },
      slots: { default: '查看详情' }
    });
    const anchor = routed.get('a');
    expect(anchor.attributes('href')).toBe('#/apps/ghostty');
    expect(anchor.classes()).toContain('bg-button-primary-bg');
    expect(anchor.text()).toBe('查看详情');
  });
});

describe('OnGetButton', () => {
  it.each([
    ['get', '获取', 'button'],
    ['open', '打开', 'button'],
    ['update', '更新', 'button'],
    ['installed', '已安装', 'span'],
    ['queued', '排队中', 'span'],
    ['unavailable', '不可用', 'span']
  ] as const)('%s 显示「%s」，渲染为 %s', (state, text, tag) => {
    const wrapper = mount(OnGetButton, { props: { state } });
    expect(wrapper.element.tagName.toLowerCase()).toBe(tag);
    expect(wrapper.text()).toBe(text);
  });

  it('Uses the injected locale', () => {
    const wrapper = mount(OnGetButton, { props: { state: 'get' }, global: withLocale('en-US') });
    expect(wrapper.text()).toBe('Get');
  });

  it('Supports label overrides and clicks', async () => {
    const wrapper = mount(OnGetButton, { props: { state: 'update', label: '更新到 1.140.0' } });
    expect(wrapper.text()).toBe('更新到 1.140.0');
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it('Shows running progress and cancellation', async () => {
    const wrapper = mount(OnGetButton, { props: { state: 'running', progress: 62.4 } });
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes('aria-valuenow')).toBe('62');
    expect(wrapper.attributes('aria-label')).toBe('取消');
    expect(wrapper.find('.on-get-indeterminate').exists()).toBe(false);
    await wrapper.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('Clamps progress and supports indeterminate state', () => {
    const over = mount(OnGetButton, { props: { state: 'running', progress: 140 } });
    expect(over.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100');
    const indeterminate = mount(OnGetButton, { props: { state: 'running' } });
    expect(indeterminate.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(indeterminate.find('.on-get-indeterminate').exists()).toBe(true);
  });
});

// These interaction fixtures explicitly exercise the Chinese UI.
testConfig.global.provide = { ...testConfig.global.provide, [fixtureLocaleKey as symbol]: localeRef('zh-CN') };
