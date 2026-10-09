import type { CollectionSummary } from '@opennavo/api';
import type { OnCollectionIcon } from '../components/OnCollectionCard.vue';

/** Collection icons: previewItems supplies package metadata and missing-icon letter/terminal fallbacks; legacy API has only iconUrls. */
export function collectionIcons(collection: CollectionSummary): OnCollectionIcon[] {
  if (collection.previewItems?.length) {
    return collection.previewItems.map(item => ({
      kind: item.kind,
      token: item.token,
      name: item.displayName,
      src: item.iconUrl,
      accent: item.accentColor
    }));
  }
  return collection.iconUrls.map(src => ({ src }));
}
