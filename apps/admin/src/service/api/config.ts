import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Remote configuration (07 §7.13).

export const fetchAppConfig = () => request<DataOf<'listAppConfig'>>({ url: '/app-config' });

export const updateAppConfig = (key: string, data: BodyOf<'updateAppConfig'>) =>
  request({ url: `/app-config/${encodeURIComponent(key)}`, method: 'put', data });
