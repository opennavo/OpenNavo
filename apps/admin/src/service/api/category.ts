import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import { request } from '../request';

// Categories (07 §7.4).

export const fetchCategoryTree = () => request<DataOf<'getCategoryTree'>>({ url: '/categories/tree' });

export const createCategory = (data: BodyOf<'createCategory'>) =>
  request<DataOf<'createCategory'>>({ url: '/categories', method: 'post', data });

export const reorderCategories = (data: BodyOf<'reorderCategories'>) =>
  request({ url: '/categories/order', method: 'put', data });

export const updateCategory = (id: number, data: BodyOf<'updateCategory'>) =>
  request({ url: `/categories/${id}`, method: 'put', data });

export const deleteCategory = (id: number) => request({ url: `/categories/${id}`, method: 'delete' });
