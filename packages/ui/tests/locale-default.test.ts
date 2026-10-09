import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { ON_UI_LOCALE, useUiLocale } from '../src/composables/locale';

const LocaleProbe = defineComponent({
  setup() {
    const locale = useUiLocale();
    return () => h('span', locale.value);
  }
});

describe('UI locale defaults', () => {
  it('uses English without an injected locale', () => {
    expect(mount(LocaleProbe).text()).toBe('en-US');
  });
  it('preserves an explicitly selected reactive locale', async () => {
    const locale = ref('zh-CN');
    const wrapper = mount(LocaleProbe, { global: { provide: { [ON_UI_LOCALE as symbol]: locale } } });
    expect(wrapper.text()).toBe('zh-CN');
    locale.value = 'ja-JP';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toBe('ja-JP');
  });
});
