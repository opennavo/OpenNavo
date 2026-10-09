import { describe, expect, it } from 'vitest';
import { CATALOG_SORTS, mergeQuery, readEnum, readFlag, readPage, readSearchQuery } from '../app/utils/catalogQuery';
import { findCategoryPath, flattenCategories } from '../app/utils/categories';
import type { CategoryNode } from '../app/utils/categories';

describe('Query parameters', () => {
  it('Page numbers, enums, switches, search terms', () => {
    expect(readPage('3')).toBe(3);
    expect(readPage(['2', '5'])).toBe(2);
    expect(readPage('0')).toBe(1);
    expect(readPage('-2')).toBe(1);
    expect(readPage('1.5')).toBe(1);
    expect(readPage(undefined)).toBe(1);
    expect(readEnum('name', CATALOG_SORTS, 'popular')).toBe('name');
    expect(readEnum('drop table', CATALOG_SORTS, 'popular')).toBe('popular');
    expect(readFlag('1')).toBe(true);
    expect(readFlag('true')).toBe(false);
    expect(readSearchQuery('  vscode  ')).toBe('vscode');
    expect(readSearchQuery('字'.repeat(80))).toHaveLength(64);
  });

  it('Merging removes defaults and filter changes can reset page', () => {
    const defaults = { page: 1, sort: 'popular', kind: 'all', disabled: false };
    expect(mergeQuery({ page: '3', sort: 'name' }, { kind: 'cask', page: undefined }, defaults)).toEqual({
      sort: 'name',
      kind: 'cask'
    });
    expect(mergeQuery({ kind: 'cask' }, { sort: 'popular', disabled: true }, defaults)).toEqual({
      kind: 'cask',
      disabled: '1'
    });
    expect(mergeQuery({ q: 'vscode', page: '2' }, { page: 1 }, defaults)).toEqual({ q: 'vscode' });
  });
});

describe('Category tree', () => {
  const node = (slug: string, children: CategoryNode[] = []): CategoryNode => ({
    slug,
    name: slug,
    icon: 'lucide:code-xml',
    appliesTo: 'both',
    hiddenByDefault: false,
    packageCount: 1,
    children
  });
  const tree = [node('developer-tools', [node('editors'), node('terminal')]), node('design')];

  it('Find paths and flatten', () => {
    expect(findCategoryPath(tree, 'terminal').map(item => item.slug)).toEqual(['developer-tools', 'terminal']);
    expect(findCategoryPath(tree, 'missing')).toEqual([]);
    expect(flattenCategories(tree).map(({ node: item, depth }) => `${depth}:${item.slug}`)).toEqual([
      '0:developer-tools',
      '1:editors',
      '1:terminal',
      '0:design'
    ]);
  });
});
