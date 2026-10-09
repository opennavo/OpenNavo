<script setup lang="ts">
import { CATEGORY_ICONS, OnIcon, UI_ICONS } from '../../../src';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnIcon icons"
    spec="08 §6"
    description="Bundled Lucide subset for interface and category icons; stroke width is 2 below 16px and 1.6 otherwise."
  >
    <div class="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-8px">
      <div
        v-for="name in [...UI_ICONS, ...CATEGORY_ICONS]"
        :key="name"
        class="flex flex-col items-center gap-6px rounded-default bg-surface-card px-6px py-10px text-ink-secondary"
      >
        <OnIcon :name="name" :size="18" />
        <span class="max-w-full truncate text-11px text-ink-tertiary">{{ name }}</span>
      </div>
    </div>
  </StorySection>
</template>
