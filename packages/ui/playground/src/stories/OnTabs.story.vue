<script setup lang="ts">
import { ref } from 'vue';
import { OnTabs } from '../../../src';
import type { OnTabItem } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

type Tab = 'overview' | 'releases' | 'deps' | 'details';
const tab = ref<Tab>('releases');
const items: OnTabItem<Tab>[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'releases', label: 'Release history', count: 42 },
  { value: 'deps', label: 'Dependencies and conflicts' },
  { value: 'details', label: 'Installation details' }
];
const linkItems = items.map(item => ({ ...item, href: `#tabs-${item.value}` }));
</script>

<template>
  <StorySection
    title="OnTabs tabs"
    spec="08 §8.14"
    description="Desktop uses a tablist within the page; web tabs are separate links."
  >
    <StoryRow label="tablist">
      <div class="w-560px"><OnTabs v-model="tab" :items="items" aria-label="Detail tabs" /></div>
    </StoryRow>
    <StoryRow label="Link mode">
      <div class="w-560px"><OnTabs model-value="overview" :items="linkItems" aria-label="Detail tabs (web)" /></div>
    </StoryRow>
  </StorySection>
</template>
