import { pluralRules } from '@opennavo/shared';
import type { App } from 'vue';
import { createI18n } from 'vue-i18n';
import { localStg } from '@/utils/storage';
import messages from './locale';
import { resolveLocale } from './preference';

const i18n = createI18n({
  locale: resolveLocale(localStg.get('lang'), navigator.languages),
  fallbackLocale: 'en-US',
  messages,
  pluralRules,
  legacy: false
});

/**
 * Setup plugin i18n
 *
 * @param app
 */
export function setupI18n(app: App) {
  app.use(i18n);
  setLocale(getLocale());
}

export const $t = i18n.global.t as App.I18n.$T;

export function setLocale(locale: App.I18n.LangType) {
  i18n.global.locale.value = locale;

  document?.querySelector('html')?.setAttribute('lang', locale);
}

export function getLocale(): App.I18n.LangType {
  return i18n.global.locale.value as App.I18n.LangType;
}
