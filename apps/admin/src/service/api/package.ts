import type { BodyOf, DataOf, QueryOf, Schemas } from '@/typings/api/opennavo';
import { request } from '../request';

// Package management/details (07 §7.2, §7.3).

export const fetchPackageList = (params: QueryOf<'listAdminPackages'>) =>
  request<DataOf<'listAdminPackages'>>({ url: '/packages', params });

export const fetchPackageDetail = (id: number) => request<DataOf<'getAdminPackage'>>({ url: `/packages/${id}` });

export const updatePackageMeta = (id: number, data: BodyOf<'updatePackageMeta'>) =>
  request({ url: `/packages/${id}/meta`, method: 'put', data });

export const updatePackageI18n = (id: number, locale: Schemas['Locale'], data: BodyOf<'updatePackageI18n'>) =>
  request({ url: `/packages/${id}/i18n/${locale}`, method: 'put', data });

export const setPackageCategories = (id: number, data: BodyOf<'setPackageCategories'>) =>
  request({ url: `/packages/${id}/categories`, method: 'put', data });

export const setPackageIcon = (id: number, assetId: number) =>
  request({ url: `/packages/${id}/icon`, method: 'put', data: { assetId } });

export const deletePackageIcon = (id: number) => request({ url: `/packages/${id}/icon`, method: 'delete' });

export const fetchPackageScreenshots = (id: number) =>
  request<DataOf<'listPackageScreenshots'>>({ url: `/packages/${id}/screenshots` });

export const addPackageScreenshot = (id: number, data: BodyOf<'addPackageScreenshot'>) =>
  request<DataOf<'addPackageScreenshot'>>({ url: `/packages/${id}/screenshots`, method: 'post', data });

export const reorderPackageScreenshots = (id: number, ids: number[]) =>
  request({ url: `/packages/${id}/screenshots/order`, method: 'put', data: { ids } });

export const updatePackageScreenshot = (id: number, screenshotId: number, data: BodyOf<'updatePackageScreenshot'>) =>
  request({ url: `/packages/${id}/screenshots/${screenshotId}`, method: 'put', data });

export const deletePackageScreenshot = (id: number, screenshotId: number) =>
  request({ url: `/packages/${id}/screenshots/${screenshotId}`, method: 'delete' });

export const fetchPackageVersions = (id: number, params: QueryOf<'listPackageVersions'>) =>
  request<DataOf<'listPackageVersions'>>({ url: `/packages/${id}/versions`, params });

export const resyncPackage = (id: number) => request({ url: `/packages/${id}/resync`, method: 'post' });

/** Write app source text (display name, summary, introduction); auto-translate other languages. */
export const updatePackageText = (id: number, data: BodyOf<'updatePackageText'>) =>
  request<DataOf<'updatePackageText'>>({ url: `/packages/${id}/text`, method: 'put', data });
