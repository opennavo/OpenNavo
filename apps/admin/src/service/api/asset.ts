import type { DataOf, QueryOf, Schemas } from '@/typings/api/opennavo';
import { request } from '../request';

// Assets (icons, screenshots, collection covers): upload yields assetId for business APIs to reference.

export const fetchAssets = (params: QueryOf<'listAssets'>) => request<DataOf<'listAssets'>>({ url: '/assets', params });

export function uploadAsset(file: File, kind: Schemas['AssetKind'], sourceUrl?: string) {
  const data = new FormData();
  data.append('file', file);
  data.append('kind', kind);
  if (sourceUrl) data.append('sourceUrl', sourceUrl);
  return request<DataOf<'uploadAsset'>>({ url: '/assets', method: 'post', data });
}
