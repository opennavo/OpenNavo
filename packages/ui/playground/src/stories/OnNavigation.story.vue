<script setup lang="ts">
import { ref } from 'vue';
import { OnBreadcrumb, OnCategoryChips, OnPagination } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const category = ref('all');
const shortCategory = ref('all');
const categories = [
  { value: 'all', label: 'All' },
  { value: 'ai', label: 'AI tools' },
  { value: 'dev', label: 'Development' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'browsers', label: 'Browsers' },
  { value: 'design', label: 'Design' },
  { value: 'media', label: 'Media' },
  { value: 'communication', label: 'Communication' },
  { value: 'utilities', label: 'System utilities' },
  { value: 'cli', label: 'Command line' },
  { value: 'games', label: 'Games' },
  { value: 'fonts', label: 'Fonts' }
];
const page = ref(5);
</script>

<template>
  <StorySection title="OnCategoryChips / OnBreadcrumb / OnPagination" spec="08 §8.27、§8.28、§8.33">
    <StoryRow label="Category filters (overflow: arrows at both ends and mouse dragging)">
      <div class="w-760px">
        <OnCategoryChips v-model="category" :items="categories" />
      </div>
    </StoryRow>
    <StoryRow label="Category filters (no overflow: no arrows)">
      <div class="w-760px">
        <OnCategoryChips v-model="shortCategory" :items="categories.slice(0, 4)" />
      </div>
    </StoryRow>
    <StoryRow label="Breadcrumbs">
      <OnBreadcrumb
        :items="[
          { label: 'Discover', href: '#nav' },
          { label: 'Development', href: '#nav' },
          { label: 'Visual Studio Code' }
        ]"
      />
    </StoryRow>
    <StoryRow label="Pagination">
      <OnPagination v-model:page="page" :page-count="20" />
    </StoryRow>
    <StoryRow label="Pagination (first and last)">
      <OnPagination :page="1" :page-count="20" />
      <OnPagination :page="3" :page-count="4" />
    </StoryRow>
  </StorySection>
</template>
