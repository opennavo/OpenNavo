<script setup lang="ts">
import { OnLogo, OnNavItem } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnLogo branding / OnNavItem sidebar navigation"
    spec="08 §2 · §8.35"
    description="The mark (N and North Star) has a minimum size of 16px; paired with the wordmark it is 22px high with an 8px gap. star draws only the North Star for badge decoration. Selected navigation items use the navActive background."
  >
    <StoryRow label="Logo">
      <OnLogo :size="16" />
      <OnLogo :size="18" />
      <OnLogo :size="22" />
      <OnLogo :size="32" />
      <OnLogo :size="40" />
      <OnLogo wordmark />
      <OnLogo star :size="13" />
      <OnLogo star :size="24" />
    </StoryRow>
    <StoryRow label="Navigation items">
      <div class="flex w-224px flex-col gap-2px rounded-big bg-surface-sidebar p-8px">
        <span class="px-8px pb-6px pt-2px text-label text-ink-tertiary">Browse</span>
        <OnNavItem icon="lucide:compass" active href="#logo">Discover</OnNavItem>
        <OnNavItem icon="lucide:layout-grid" href="#logo">Categories</OnNavItem>
        <OnNavItem icon="lucide:chart-no-axes-column" href="#logo">Rankings</OnNavItem>
        <span class="px-8px pb-6px pt-10px text-label text-ink-tertiary">My library</span>
        <OnNavItem icon="lucide:package" :count="218" href="#logo">Installed</OnNavItem>
        <OnNavItem icon="lucide:circle-arrow-down" :badge="6" badge-label="6 updates available" href="#logo"
          >Updates</OnNavItem
        >
        <OnNavItem icon="lucide:rotate-ccw-clock" href="#logo">Update history</OnNavItem>
      </div>
    </StoryRow>
  </StorySection>
</template>
