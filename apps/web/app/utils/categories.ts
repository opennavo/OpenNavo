import type { PublicComponents } from '@opennavo/api';

export type CategoryNode = PublicComponents['schemas']['CategoryNode'];

/** Find a category slug and return its root-to-node path, or an empty array. */
export function findCategoryPath(nodes: readonly CategoryNode[], slug: string): CategoryNode[] {
  for (const node of nodes) {
    if (node.slug === slug) return [node];
    const rest = findCategoryPath(node.children, slug);
    if (rest.length) return [node, ...rest];
  }
  return [];
}

/** Flatten categories for the rankings selector. */
export function flattenCategories(nodes: readonly CategoryNode[], depth = 0): { node: CategoryNode; depth: number }[] {
  return nodes.flatMap(node => [{ node, depth }, ...flattenCategories(node.children, depth + 1)]);
}
