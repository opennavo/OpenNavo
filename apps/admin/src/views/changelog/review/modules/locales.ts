import type { RecordOf } from '@/typings/api/opennavo';
import { CONTENT_LOCALES } from '@/utils/content-locale';
import type { ContentLocale } from '@/utils/content-locale';

/** Initially select failed, missing, or source-changed languages for retranslation; otherwise all non-source languages. */
export function defaultRetranslateLocales(item: RecordOf<'listTranslations'>): ContentLocale[] {
  const targets = CONTENT_LOCALES.filter(code => code !== item.sourceLocale);
  const broken = targets.filter(code => ['failed', 'missing'].includes(item.i18n[code].status) || item.i18n[code].stale);
  return broken.length ? broken : targets;
}
