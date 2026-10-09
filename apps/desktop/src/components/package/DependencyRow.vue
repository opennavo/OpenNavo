<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { DependencyNode } from '@opennavo/api';
import { formatVersion } from '@opennavo/shared';
import { OnAppIcon, OnChip, OnIcon } from '@opennavo/ui';
import { useLibraryStore } from '@/stores';

// Dependency row: tile, name, version, summary; only apps link to details (ADR-018); mark locally installed entries.
const props = defineProps<{ node: DependencyNode; expandable?: boolean }>();

const { t } = useI18n();
const library = useLibraryStore();
const installed = () => Boolean(library.find(props.node.kind, props.node.token));
</script>

<template>
  <span class="flex min-h-40px items-center gap-10px py-4px">
    <OnIcon v-if="expandable" name="chevron-right" :size="14" class="dependency-chevron shrink-0 text-ink-tertiary" />
    <span v-else class="w-14px shrink-0"></span>
    <OnAppIcon :kind="node.kind" :token="node.token" :name="node.name" :size="26" />
    <RouterLink
      v-if="node.kind === 'cask'"
      :to="`/package/cask/${node.token}`"
      class="truncate rounded-tiny text-13px font-600 text-ink-primary no-underline outline-none hover:underline focus-visible:shadow-focus-ring"
      @click.stop
    >
      {{ node.name }}
    </RouterLink>
    <span v-else class="truncate text-13px font-600 text-ink-primary">{{ node.name }}</span>
    <span v-if="node.version" class="shrink-0 font-mono text-11.5px text-component-mono-text">{{
      formatVersion(node.version)
    }}</span>
    <OnChip v-if="installed()" tone="success" dot>{{ t('library.status.installed') }}</OnChip>
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
