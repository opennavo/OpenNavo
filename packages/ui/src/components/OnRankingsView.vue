<script setup lang="ts" generic="P extends string">
import type { Component } from 'vue';
import type { PackageSummary } from '@opennavo/api';
import OnPageHeader from './OnPageHeader.vue';
import OnRankRow from './OnRankRow.vue';
import OnSegmented from './OnSegmented.vue';
import OnSkeleton from './OnSkeleton.vue';
import type { OnSegmentedOption } from '../types';

// Rankings (08 §10.3, ADR-017): title/period selector with optional filters, rows in two columns at xl+, host actions right.
// Shared desktop/web; host supplies data, links, buttons, formatted install counts.
export interface OnRankingsEntry {
  rank: number;
  /** Rank change versus seven days ago; hide when unavailable. */
  change?: number | null;
  pkg: PackageSummary;
  value: string;
  href: string;
}

export interface OnRankingsViewProps<V extends string> {
  title: string;
  subtitle?: string;
  periods: readonly OnSegmentedOption<V>[];
  period: V;
  periodLabel: string;
  /** null means loading; show skeletons. */
  entries: readonly OnRankingsEntry[] | null;
  linkAs?: string | Component;
}

withDefaults(defineProps<OnRankingsViewProps<P>>(), { linkAs: 'a' });

const emit = defineEmits<{ 'update:period': [value: P] }>();

defineSlots<{
  /** Filter left of period selector, e.g. web category selector. */
  filters?: () => unknown;
  /** Action button on each row's right. */
  action?: (props: { entry: OnRankingsEntry }) => unknown;
  /** Loaded without data. */
  empty?: () => unknown;
  /** After list, e.g. web pagination. */
  footer?: () => unknown;
}>();
</script>

<template>
  <div class="flex flex-col">
    <OnPageHeader :title="title" :subtitle="subtitle">
      <template #actions>
        <slot name="filters" />
        <OnSegmented
          :model-value="period"
          size="sm"
          :aria-label="periodLabel"
          :options="periods"
          @update:model-value="emit('update:period', $event)"
        />
      </template>
    </OnPageHeader>
    <div v-if="entries === null" class="grid grid-cols-1 gap-8px xl:grid-cols-2" aria-hidden="true">
      <OnSkeleton v-for="index in 10" :key="index" height="58px" radius="default" />
    </div>
    <ol v-else-if="entries.length" class="m-0 grid list-none grid-cols-1 gap-8px p-0 xl:grid-cols-2">
      <li v-for="entry in entries" :key="entry.pkg.token" class="flex items-center gap-10px">
        <OnRankRow
          class="min-w-0 flex-1"
          :rank="entry.rank"
          :change="entry.change ?? null"
          :pkg="entry.pkg"
          :value="entry.value"
          :href="entry.href"
          :link-as="linkAs"
        />
        <slot name="action" :entry="entry" />
      </li>
    </ol>
    <slot v-else name="empty" />
    <slot name="footer" />
  </div>
</template>
