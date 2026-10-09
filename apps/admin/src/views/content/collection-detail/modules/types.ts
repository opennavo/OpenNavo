import type { Schemas } from '@/typings/api/opennavo';
import type { ContentLocale, LocalizedTexts } from '@/utils/content-locale';

/** Editable collection items: recommendations stored by locale; write only source and changed languages (04 §9.1). */
export interface EditableItem {
  packageId: number;
  kind: Schemas['PackageKind'];
  token: string;
  name: string;
  iconUrl: string | null;
  disabled: boolean;
  sourceLocale: ContentLocale;
  notes: LocalizedTexts;
  /** Originally loaded recommendations, for detecting changed languages. */
  original: LocalizedTexts;
}
