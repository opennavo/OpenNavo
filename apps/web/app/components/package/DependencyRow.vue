<script setup lang="ts">
import type { PublicComponents } from '@opennavo/api';
import { formatVersion } from '@opennavo/shared';
import { OnAppIcon, OnIcon } from '@opennavo/ui';

type DependencyNode = PublicComponents['schemas']['DependencyNode'];

defineProps<{ node: DependencyNode; href?: string; expandable?: boolean }>();
</script>

<template>
  <span class="flex min-h-40px items-center gap-10px py-4px">
    <OnIcon v-if="expandable" name="chevron-right" :size="14" class="dependency-chevron shrink-0 text-ink-tertiary" />
    <span v-else class="w-14px shrink-0"></span>
    <OnAppIcon :kind="node.kind" :token="node.token" :name="node.name" :size="26" />
    <NuxtLink
      v-if="href"
      :to="href"
      class="truncate rounded-tiny text-13px font-600 text-ink-primary no-underline outline-none hover:underline focus-visible:shadow-focus-ring"
      @click.stop
    >
      {{ node.name }}
    </NuxtLink>
    <span v-else class="truncate text-13px font-600 text-ink-primary">{{ node.name }}</span>
    <span v-if="node.version" class="shrink-0 font-mono text-11.5px text-component-mono-text">{{
      formatVersion(node.version)
    }}</span>
    <span v-if="node.summary" class="min-w-0 truncate text-12px text-ink-tertiary">{{ node.summary }}</span>
  </span>
</template>

<style>
details[open] > summary .dependency-chevron {
  transform: rotate(90deg);
}

summary::-webkit-details-marker {
  display: none;
}
</style>
