import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Translation management (07 §7.8; review removed in 12).

export const fetchTranslationQueue = (params: QueryOf<'listTranslationQueue'>) =>
  request<DataOf<'listTranslationQueue'>>({ url: '/translations/queue', params });

// Translation management (M9-02): six-language states, retranslation, single-language correction.

export const fetchTranslations = (params: QueryOf<'listTranslations'>) =>
  request<DataOf<'listTranslations'>>({ url: '/translations', params });

export const fetchTranslationStatus = (params: QueryOf<'getTranslationStatus'>) =>
  request<DataOf<'getTranslationStatus'>>({ url: '/translations/status', params });

export const retranslateContent = (data: BodyOf<'retranslateContent'>) =>
  request<DataOf<'retranslateContent'>>({ url: '/translations/retranslate', method: 'post', data });

export const fixTranslation = (data: BodyOf<'fixTranslation'>) =>
  request<DataOf<'fixTranslation'>>({ url: '/translations/fix', method: 'put', data });

// Content glossary: fixed translations and no-translate terms.

export const fetchGlossary = (params: QueryOf<'listGlossary'>) =>
  request<DataOf<'listGlossary'>>({ url: '/glossary', params });

export const upsertGlossaryTerm = (data: BodyOf<'upsertGlossaryTerm'>) =>
  request<DataOf<'upsertGlossaryTerm'>>({ url: '/glossary', method: 'put', data });

export const deleteGlossaryTerm = (id: number) => request({ url: `/glossary/${id}`, method: 'delete' });
