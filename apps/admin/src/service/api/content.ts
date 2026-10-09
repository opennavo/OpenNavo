import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Collections and features (07 §7.5, §7.6).

export const fetchCollectionList = (params: QueryOf<'listAdminCollections'>) =>
  request<DataOf<'listAdminCollections'>>({ url: '/collections', params });

export const createCollection = (data: BodyOf<'createCollection'>) =>
  request<DataOf<'createCollection'>>({ url: '/collections', method: 'post', data });

export const fetchCollectionDetail = (id: number) =>
  request<DataOf<'getAdminCollection'>>({ url: `/collections/${id}` });

export const updateCollection = (id: number, data: BodyOf<'updateCollection'>) =>
  request({ url: `/collections/${id}`, method: 'put', data });

export const deleteCollection = (id: number) => request({ url: `/collections/${id}`, method: 'delete' });

export const setCollectionItems = (id: number, data: BodyOf<'setCollectionItems'>) =>
  request({ url: `/collections/${id}/items`, method: 'put', data });

export const publishCollection = (id: number, data: BodyOf<'publishCollection'>) =>
  request({ url: `/collections/${id}/publish`, method: 'post', data });

export const unpublishCollection = (id: number) => request({ url: `/collections/${id}/unpublish`, method: 'post' });

export const fetchFeatureList = (params: QueryOf<'listFeatures'>) =>
  request<DataOf<'listFeatures'>>({ url: '/features', params });

export const createFeature = (data: BodyOf<'createFeature'>) =>
  request<DataOf<'createFeature'>>({ url: '/features', method: 'post', data });

export const fetchFeature = (id: number) => request<DataOf<'getFeature'>>({ url: `/features/${id}` });

export const updateFeature = (id: number, data: BodyOf<'updateFeature'>) =>
  request({ url: `/features/${id}`, method: 'put', data });

export const deleteFeature = (id: number) => request({ url: `/features/${id}`, method: 'delete' });

// Desktop announcement (Content, formerly desktop.announcement configuration): author source only, auto-translate the rest.

export const fetchAnnouncement = () => request<DataOf<'getAnnouncement'>>({ url: '/announcement' });

export const updateAnnouncement = (data: BodyOf<'updateAnnouncement'>) =>
  request<DataOf<'updateAnnouncement'>>({ url: '/announcement', method: 'put', data });
