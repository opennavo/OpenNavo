import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Search insights and synonyms (07 §7.10).

export const fetchTopQueries = (params: QueryOf<'listTopQueries'>) =>
  request<DataOf<'listTopQueries'>>({ url: '/search/insights/top', params });

export const fetchZeroResultQueries = (params: QueryOf<'listZeroResultQueries'>) =>
  request<DataOf<'listZeroResultQueries'>>({ url: '/search/insights/zero', params });

export const fetchSynonyms = (params: QueryOf<'listSynonyms'>) =>
  request<DataOf<'listSynonyms'>>({ url: '/search/synonyms', params });

export const createSynonym = (data: BodyOf<'createSynonym'>) =>
  request<DataOf<'createSynonym'>>({ url: '/search/synonyms', method: 'post', data });

export const updateSynonym = (id: number, data: BodyOf<'updateSynonym'>) =>
  request({ url: `/search/synonyms/${id}`, method: 'put', data });

export const deleteSynonym = (id: number) => request({ url: `/search/synonyms/${id}`, method: 'delete' });
