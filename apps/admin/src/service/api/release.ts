import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Desktop releases and mirrors (07 §7.12, §7.13).

export const fetchDesktopReleases = (params: QueryOf<'listDesktopReleases'>) =>
  request<DataOf<'listDesktopReleases'>>({ url: '/desktop-releases', params });

export const fetchDesktopRelease = (id: number) =>
  request<DataOf<'getDesktopRelease'>>({ url: `/desktop-releases/${id}` });

export const updateDesktopRelease = (id: number, data: BodyOf<'updateDesktopRelease'>) =>
  request({ url: `/desktop-releases/${id}`, method: 'put', data });

export const publishDesktopRelease = (id: number) =>
  request({ url: `/desktop-releases/${id}/publish`, method: 'post' });

export const rollbackDesktopRelease = (id: number) =>
  request({ url: `/desktop-releases/${id}/rollback`, method: 'post' });

export const fetchMirrors = () => request<DataOf<'listMirrors'>>({ url: '/mirrors' });

export const createMirror = (data: BodyOf<'createMirror'>) =>
  request<DataOf<'createMirror'>>({ url: '/mirrors', method: 'post', data });

export const updateMirror = (id: number, data: BodyOf<'updateMirror'>) =>
  request({ url: `/mirrors/${id}`, method: 'put', data });

export const deleteMirror = (id: number) => request({ url: `/mirrors/${id}`, method: 'delete' });
