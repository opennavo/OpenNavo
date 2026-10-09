import { useAppStore } from '@/store/modules/app';
import { pickLocalized } from '@/utils/content-locale';
import type { ContentLocale } from '@/utils/content-locale';

type Texts = Partial<Record<ContentLocale, string | null>>;

interface LocalizedPackage {
  name: string;
  displayName?: Texts;
  summary?: Texts;
  sourceLocale?: ContentLocale;
}

/** Admin app text (six-language mappings, 04 §9.1): UI → source → English → any locale; names finally fall back to upstream names. */
export function useLocalizedPackage() {
  const appStore = useAppStore();
  const nameOf = (pkg: LocalizedPackage) => pickLocalized(pkg.displayName, appStore.locale, pkg.sourceLocale) ?? pkg.name;
  const summaryOf = (pkg: LocalizedPackage) => pickLocalized(pkg.summary, appStore.locale, pkg.sourceLocale) ?? null;
  return { nameOf, summaryOf };
}
