import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Feedback (07 §7.11).

export const fetchFeedbackList = (params: QueryOf<'listFeedback'>) =>
  request<DataOf<'listFeedback'>>({ url: '/feedback', params });

export const fetchFeedback = (id: number) => request<DataOf<'getFeedback'>>({ url: `/feedback/${id}` });

export const updateFeedback = (id: number, data: BodyOf<'updateFeedback'>) =>
  request({ url: `/feedback/${id}`, method: 'put', data });
