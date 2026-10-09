<script setup lang="ts">
import { ref } from 'vue';
import { OnGetButton } from '../../../src';
import type { GetState } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const states: GetState[] = ['get', 'open', 'installed', 'update', 'queued', 'running', 'unavailable'];
const progress = ref(62);
</script>

<template>
  <StorySection
    title="OnGetButton install buttons"
    spec="08 §8.2"
    description="Shows the local package state; running displays circular progress and a stop square on hover or focus."
  >
    <StoryRow label="All states">
      <div v-for="state in states" :key="state" class="flex flex-col items-center gap-6px">
        <OnGetButton :state="state" :progress="state === 'running' ? progress : undefined" />
        <span class="text-caption text-ink-tertiary">{{ state }}</span>
      </div>
    </StoryRow>
    <StoryRow label="Progress">
      <OnGetButton state="running" :progress="0" />
      <OnGetButton state="running" :progress="25" />
      <OnGetButton state="running" :progress="62" />
      <OnGetButton state="running" :progress="100" />
      <OnGetButton state="running" />
      <span class="text-caption text-ink-tertiary">The last example is indeterminate</span>
    </StoryRow>
    <StoryRow label="Custom labels">
      <OnGetButton state="update" label="Update to 1.140.0" />
      <OnGetButton state="get" label="Get" />
    </StoryRow>
  </StorySection>
</template>
