import { dateEnUS, dateZhCN, dateJaJP, dateEsAR, datePtBR, dateRuRU, enUS, zhCN, jaJP, esAR, ptBR, ruRU } from 'naive-ui';
import type { NDateLocale, NLocale } from 'naive-ui';

export const naiveLocales: Record<App.I18n.LangType, NLocale> = {
  'zh-CN': zhCN, 'en-US': enUS, 'ja-JP': jaJP, 'es-ES': esAR, 'pt-BR': ptBR, 'ru-RU': ruRU
};
export const naiveDateLocales: Record<App.I18n.LangType, NDateLocale> = {
  'zh-CN': dateZhCN, 'en-US': dateEnUS, 'ja-JP': dateJaJP, 'es-ES': dateEsAR, 'pt-BR': datePtBR, 'ru-RU': dateRuRU
};
