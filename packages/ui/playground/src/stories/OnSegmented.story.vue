<script setup lang="ts">
import { ref } from 'vue';
import { OnSegmented } from '../../../src';
import type { OnSegmentedOption } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

type View = 'all' | 'app' | 'cli';
const view = ref<View>('app');
const options: OnSegmentedOption<View>[] = [
  { value: 'all', label: 'All', count: 218 },
  { value: 'app', label: 'App', count: 38 },
  { value: 'cli', label: 'Command line', count: 180 }
];

type Period = '30d' | '90d' | '365d';
const period = ref<Period>('30d');
const periods: OnSegmentedOption<Period>[] = [
  { value: '30d', label: '30 days', dots: ['chart-emphasis'] },
  { value: '90d', label: '90 days', dots: ['chart-series1', 'chart-series2'] },
  { value: '365d', label: '365 days', dots: ['chart-series1', 'chart-series2', 'chart-series3'] }
];
</script>

<template>
  <StorySection
    title="OnSegmented segmented controls"
    spec="08 §8.5"
    description="Radio-group semantics: arrow keys change selection; Home and End move to the ends."
  >
    <StoryRow label="md + counts">
      <OnSegmented v-model="view" :options="options" aria-label="Type filter" />
      <span class="text-caption text-ink-tertiary">Current: {{ view }}</span>
    </StoryRow>
    <StoryRow label="sm + dots">
      <OnSegmented v-model="period" :options="periods" size="sm" aria-label="Time range" />
    </StoryRow>
  </StorySection>
</template>
