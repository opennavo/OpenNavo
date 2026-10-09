<script setup lang="ts">
import type { PublicComponents } from '@opennavo/api';
import { packageLink } from '~/utils/packageView';

type DependencyNode = PublicComponents['schemas']['DependencyNode'];

// Dependency tree (08 §10.7): tile/name/version rows; only Casks link to details (ADR-018); expand depth < expandDepth.
const props = withDefaults(defineProps<{ nodes: readonly DependencyNode[]; depth?: number; expandDepth?: number }>(), {
  depth: 0,
  expandDepth: 2
});

const localePath = useLocalePath();

function hrefOf(node: DependencyNode): string | undefined {
  const path = packageLink(node.kind, node.token);
  return path ? localePath(path) : undefined;
}
</script>

<template>
  <ul class="m-0 list-none p-0" :class="depth > 0 ? 'ml-14px border-l border-l-solid border-line-subtle pl-12px' : ''">
    <li v-for="node in nodes" :key="`${node.kind}/${node.token}`">
      <details v-if="node.children.length" :open="depth + 1 < expandDepth">
        <summary class="cursor-pointer list-none">
          <DependencyRow :node="node" :href="hrefOf(node)" expandable />
        </summary>
        <DependencyTree :nodes="node.children" :depth="depth + 1" :expand-depth="props.expandDepth" />
      </details>
      <DependencyRow v-else :node="node" :href="hrefOf(node)" />
    </li>
  </ul>
</template>
