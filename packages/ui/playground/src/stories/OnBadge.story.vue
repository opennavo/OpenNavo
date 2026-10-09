<script setup lang="ts">
import { OnBadge } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection title="OnBadge badges and counts" spec="08 §8.4">
    <StoryRow label="Count badges">
      <OnBadge :count="6" label="6 updates available" />
      <OnBadge :count="42" />
      <OnBadge :count="128" />
    </StoryRow>
    <StoryRow label="Text badges">
      <OnBadge star>Featured this week</OnBadge>
      <OnBadge>New version</OnBadge>
    </StoryRow>
  </StorySection>
</template>
