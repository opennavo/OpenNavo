import { locale } from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';
import 'dayjs/locale/ja';
import 'dayjs/locale/es';
import 'dayjs/locale/pt-br';
import 'dayjs/locale/ru';
import { getLocale } from './index';

const localMap: Record<App.I18n.LangType, string> = {
  'zh-CN': 'zh-cn', 'en-US': 'en', 'ja-JP': 'ja', 'es-ES': 'es', 'pt-BR': 'pt-br', 'ru-RU': 'ru'
};
export function setDayjsLocale(lang: App.I18n.LangType = getLocale()) {
  locale(localMap[lang]);
}
