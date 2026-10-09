<script setup lang="ts">
import { OnCard } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnCard cards"
    spec="08 §8.8"
    description="Cards use borders and backgrounds without shadows; interactive cards brighten the border and darken the background on hover."
  >
    <StoryRow label="Padding">
      <OnCard padding="sm" class="w-200px"><span class="text-body-sm text-ink-secondary">sm · 14</span></OnCard>
      <OnCard class="w-200px"><span class="text-body-sm text-ink-secondary">md · 16 (default)</span></OnCard>
      <OnCard padding="lg" class="w-200px"><span class="text-body-sm text-ink-secondary">lg · 18</span></OnCard>
    </StoryRow>
    <StoryRow label="Interactive">
      <OnCard href="#card" interactive class="w-280px">
        <span class="block text-headline text-ink-primary">12 essentials for a new Mac</span>
        <span class="mt-4px block text-body-sm text-ink-secondary">
          Terminals, launchers, notes, media players, and everyday command-line tools.
        </span>
      </OnCard>
    </StoryRow>
  </StorySection>
</template>
