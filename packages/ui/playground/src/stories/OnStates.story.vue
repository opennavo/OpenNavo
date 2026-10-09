<script setup lang="ts">
import { OnButton, OnCard, OnEmpty, OnErrorState, OnOffline, OnSkeleton } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnEmpty / OnErrorState / OnOffline / OnSkeleton"
    spec="08 §8.29、§8.30"
    description="Copy follows 08 §12.5; retain old content at 60% opacity while refetching to avoid flashing skeletons."
  >
    <div class="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-12px">
      <OnCard padding="none">
        <OnEmpty
          icon="lucide:search"
          title="No results for “vscodee”"
          description="Try an English name or pinyin, or suggest an app to add."
        >
          <template #actions><OnButton variant="secondary" size="sm">Suggest an app</OnButton></template>
        </OnEmpty>
      </OnCard>
      <OnCard padding="none"><OnErrorState request-id="req-01JTQ8" /></OnCard>
      <OnCard padding="none"><OnOffline /></OnCard>
    </div>
    <StoryRow label="Skeleton">
      <OnCard class="w-360px">
        <div class="flex items-start gap-12px">
          <OnSkeleton width="44px" height="44px" radius="app-icon" />
          <div class="flex-1"><OnSkeleton :lines="2" height="12px" /></div>
        </div>
      </OnCard>
      <OnCard class="w-360px"><OnSkeleton :lines="4" height="10px" radius="tiny" /></OnCard>
    </StoryRow>
  </StorySection>
</template>
