<script setup lang="ts">
import { ref } from 'vue';
import { OnToggle } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const autoUpdate = ref(true);
const greedy = ref(false);
</script>

<template>
  <StorySection
    title="OnToggle switches"
    spec="08 §8.6"
    description="Settings rows place labels on the left and switches on the right."
  >
    <StoryRow label="State">
      <OnToggle :model-value="false" aria-label="Off" />
      <OnToggle :model-value="true" aria-label="On" />
      <OnToggle :model-value="false" disabled aria-label="Disabled (off)" />
      <OnToggle :model-value="true" disabled aria-label="Disabled (on)" />
    </StoryRow>
    <StoryRow label="Settings rows">
      <div
        class="flex w-420px flex-col divide-y divide-line-subtle rounded-big border border-solid border-line-subtle bg-surface-card"
      >
        <div class="flex items-center justify-between gap-16px px-16px py-12px">
          <span id="toggle-auto" class="text-body text-ink-primary">Automatically update command-line tools</span>
          <OnToggle v-model="autoUpdate" aria-labelledby="toggle-auto" />
        </div>
        <div class="flex items-center justify-between gap-16px px-16px py-12px">
          <span id="toggle-greedy" class="text-body text-ink-primary">Include apps with built-in updaters</span>
          <OnToggle v-model="greedy" aria-labelledby="toggle-greedy" />
        </div>
      </div>
    </StoryRow>
  </StorySection>
</template>
