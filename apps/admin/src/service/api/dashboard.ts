import type { DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

/** Dashboard overview (07 §7.1). */
export const fetchDashboardOverview = () => request<DataOf<'getDashboardOverview'>>({ url: '/dashboard/overview' });

/** First activity per device/browser on a Beijing calendar day, grouped by hour. */
export const fetchDashboardUsageIntraday = (params?: QueryOf<'getDashboardUsageIntraday'>) =>
  request<DataOf<'getDashboardUsageIntraday'>>({ url: '/dashboard/usage/intraday', params });
