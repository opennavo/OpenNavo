import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, pluralRules } from '@opennavo/shared';
import type { Locale } from '@opennavo/shared';
import enUS from './en-US';
import zhCN from './zh-CN';
import jaJP from './ja-JP.json';
import esES from './es-ES.json';
import ptBR from './pt-BR.json';
import ruRU from './ru-RU.json';

export type MessageSchema = typeof zhCN;

// Main and tray windows read the effective locale before mounting, then listen for locale:changed.
export const i18n = createI18n<[MessageSchema], Locale, false>({
  legacy: false,
  pluralRules,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
    'ja-JP': jaJP,
    'es-ES': esES,
    'pt-BR': ptBR,
    'ru-RU': ruRU
  }
});
