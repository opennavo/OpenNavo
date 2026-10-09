import type { DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

/** Dashboard overview (07 §7.1). */
export const fetchDashboardOverview = () => request<DataOf<'getDashboardOverview'>>({ url: '/dashboard/overview' });

/** LLM usage over the last N months. */
export const fetchLlmUsage = (params: QueryOf<'getLlmUsage'>) =>
  request<DataOf<'getLlmUsage'>>({ url: '/dashboard/llm-usage', params });
