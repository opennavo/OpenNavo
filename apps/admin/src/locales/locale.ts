import zhCN from './langs/zh-cn';
import enUS from './langs/en-us';
import jaJP from './langs/ja-jp.json';
import esES from './langs/es-es.json';
import ptBR from './langs/pt-br.json';
import ruRU from './langs/ru-ru.json';

const locales: Record<App.I18n.LangType, App.I18n.Schema> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
  'es-ES': esES,
  'pt-BR': ptBR,
  'ru-RU': ruRU
};

export default locales;
