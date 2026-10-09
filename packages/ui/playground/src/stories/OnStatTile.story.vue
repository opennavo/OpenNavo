<script setup lang="ts">
import { OnStatTile } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnStatTile statistic cards"
    spec="08 §8.9"
    description="sm: a 2×2 statistics panel; md: one detail data cell, with separators supplied by its container."
  >
    <StoryRow label="sm (statistics panel)">
      <div class="grid w-360px grid-cols-[repeat(2,minmax(0,1fr))] gap-8px">
        <OnStatTile label="Installed" value="218" hint="Includes 38 apps" />
        <OnStatTile label="Update available" value="6" hint="About 1.1 GB to download" />
        <OnStatTile label="Disk usage" value="18.6" unit="GB" hint="Includes 2.3 GB of cache" />
        <OnStatTile label="Last checked" value="5" unit="minutes ago" hint="Automatically at 09:00 daily" />
      </div>
    </StoryRow>
    <StoryRow label="md (data row)">
      <div
        class="flex w-760px divide-x divide-line-subtle rounded-big border border-solid border-line-subtle bg-surface-card py-14px"
      >
        <OnStatTile
          size="md"
          label="Installs in the last 30 days"
          value="17,394"
          :delta="{ value: '12%', direction: 'up', good: true }"
        />
        <OnStatTile size="md" label="Rank" value="#9" hint="Cask rankings" />
        <OnStatTile size="md" label="Version" value="1.140.0" />
        <OnStatTile size="md" label="Size" value="318" unit="MB" />
        <OnStatTile
          size="md"
          label="Failure rate"
          value="0.4%"
          :delta="{ value: '0.1%', direction: 'up', good: false }"
        />
      </div>
    </StoryRow>
  </StorySection>
</template>
