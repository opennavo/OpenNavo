<script setup lang="ts">
import type { DependencyNode } from '@opennavo/api';
import DependencyRow from './DependencyRow.vue';

// Dependency tree (08 §10.7): expand nodes with depth < expandDepth by default.
const props = withDefaults(defineProps<{ nodes: readonly DependencyNode[]; depth?: number; expandDepth?: number }>(), {
  depth: 0,
  expandDepth: 2
});
</script>

<template>
  <ul class="m-0 list-none p-0" :class="depth > 0 ? 'ml-14px border-l border-l-solid border-line-subtle pl-12px' : ''">
    <li v-for="node in nodes" :key="`${node.kind}/${node.token}`">
      <details v-if="node.children.length" :open="depth + 1 < expandDepth">
        <summary class="cursor-pointer list-none">
          <DependencyRow :node="node" expandable />
        </summary>
        <DependencyTree :nodes="node.children" :depth="depth + 1" :expand-depth="props.expandDepth" />
      </details>
      <DependencyRow v-else :node="node" />
    </li>
  </ul>
</template>
