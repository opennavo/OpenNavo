import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { OnMenu } from '@opennavo/ui';
import SettingsPage from '@/pages/SettingsPage.vue';
import { i18n } from '@/i18n';
import { startAppLocale } from '@/composables/startAppLocale';
import { useSettingsStore } from '@/stores/settings';
import { setup } from './helpers';

vi.mock('@/composables/useClientConfig', () => ({ fetchClientConfig: async () => null }));

describe('Language settings menu', () => {
  it('System first, then six native language names; save manual/system modes separately', async () => {
    const { pinia, router } = await setup('/settings/general');
    const settings = useSettingsStore();
    await settings.load();
    const stop = await startAppLocale();
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router, i18n] } });
    try {
      await flushPromises();
      const menu = wrapper.findComponent(OnMenu);
      const items = menu.props('items');
      expect(items.map(item => item.key)).toEqual(['system', 'en-US', 'zh-CN', 'ja-JP', 'es-ES', 'pt-BR', 'ru-RU']);
      expect(items[0]?.label).toBe('跟随系统（当前：简体中文）');
      expect(items.map(item => item.label)).toEqual([
        '跟随系统（当前：简体中文）',
        'English',
        '简体中文',
        '日本語',
        'Español',
        'Português (Brasil)',
        'Русский'
      ]);
      expect(wrapper.text()).toContain('系统对话框重启后切换语言。');
      menu.vm.$emit('select', 'ru-RU');
      await flushPromises();
      expect(settings.value).toMatchObject({ locale: 'ru-RU', localeMode: 'manual' });
      expect(i18n.global.locale.value).toBe('ru-RU');
      menu.vm.$emit('select', 'system');
      await flushPromises();
      expect(settings.value?.localeMode).toBe('system');
      expect(wrapper.text()).toContain(menu.props('items')[0]!.label);
      expect(i18n.global.locale.value).toBe(settings.value?.locale);
    } finally {
      wrapper.unmount();
      stop();
    }
  });
});
