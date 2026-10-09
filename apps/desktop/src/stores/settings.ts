import { ref } from 'vue';
import { defineStore } from 'pinia';
import { commands, unwrap } from '@/ipc/client';
import type { AppSettings } from '@/ipc/client';

/** Settings (06 §11): settings_set replaces the whole object and returns normalized values. */
export const useSettingsStore = defineStore('settings', () => {
  const value = ref<AppSettings | null>(null);
  let pending: Promise<void> = Promise.resolve();

  // Serialize full-object writes and merge the latest saved settings at execution time.
  function serialize(operation: () => Promise<void>) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function load() {
    await serialize(async () => {
      value.value = (await unwrap(commands.settingsGet())) as AppSettings;
    });
  }

  async function save(next: AppSettings) {
    await serialize(async () => {
      value.value = (await unwrap(commands.settingsSet(next))) as AppSettings;
    });
  }

  async function update<K extends keyof AppSettings>(key: K, entry: AppSettings[K]) {
    await serialize(async () => {
      if (!value.value) return;
      value.value = (await unwrap(commands.settingsSet({ ...value.value, [key]: entry }))) as AppSettings;
    });
  }

  async function setLanguage(locale: AppSettings['locale'] | 'system') {
    await serialize(async () => {
      if (!value.value) return;
      const next =
        locale === 'system'
          ? { ...value.value, localeMode: 'system' as const }
          : { ...value.value, locale, localeMode: 'manual' as const };
      value.value = (await unwrap(commands.settingsSet(next))) as AppSettings;
    });
  }

  return { value, load, save, update, setLanguage };
});
