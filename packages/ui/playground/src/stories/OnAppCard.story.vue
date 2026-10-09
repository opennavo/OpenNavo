<script setup lang="ts">
import { formatCountCompact } from '@opennavo/shared';
import { OnAppCard, OnAppRow, OnButton, OnChip, OnGetButton, OnRankRow } from '../../../src';
import type { GetState } from '../../../src';
import { samplePackages } from '../data/packages';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const states: GetState[] = ['get', 'update', 'get', 'open', 'get', 'open'];
const ranked = [samplePackages[6], samplePackages[1], samplePackages[3], samplePackages[0]].filter(
  pkg => pkg !== undefined
);
</script>

<template>
  <StorySection
    title="OnAppCard / OnAppRow / OnRankRow"
    spec="08 §8.11–§8.12"
    description="The three-column grid uses minmax(0, 1fr) so long names stay within the grid; name links cover the entire card."
  >
    <div class="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-12px">
      <OnAppCard
        v-for="(pkg, index) in samplePackages.slice(0, 6)"
        :key="pkg.token"
        :pkg="pkg"
        :state="states[index] ?? 'get'"
        :href="`#${pkg.token}`"
      />
    </div>
    <StoryRow label="Progress and categories">
      <div class="w-360px">
        <OnAppCard :pkg="samplePackages[0]!" state="running" :progress="62" :stats="['version', 'category']" />
      </div>
    </StoryRow>
    <StoryRow label="Ranking rows">
      <div class="flex w-360px flex-col gap-8px">
        <OnRankRow
          v-for="(pkg, index) in ranked"
          :key="pkg.token"
          :rank="index + 1"
          :pkg="pkg"
          :value="formatCountCompact(pkg.installs30d)"
          :href="`#${pkg.token}`"
        />
      </div>
    </StoryRow>
    <StoryRow label="List rows">
      <div class="w-640px rounded-big border border-solid border-line-subtle bg-surface-card px-16px">
        <OnAppRow
          kind="cask"
          token="docker-desktop"
          name="Docker Desktop"
          accent="#1D63ED"
          meta="4.92.1 → 4.93.0"
          description="About 600 MB to download"
        >
          <template #actions><OnButton variant="primary" size="sm" shape="round">Updates</OnButton></template>
        </OnAppRow>
        <OnAppRow
          kind="cask"
          token="visual-studio-code"
          name="Visual Studio Code"
          accent="#2F8FEF"
          meta="1.139.1 → 1.140.0"
          description="The app updates itself"
        >
          <template #badges><OnChip tone="info">Built-in updater</OnChip></template>
          <template #actions><OnGetButton state="update" /></template>
        </OnAppRow>
        <OnAppRow
          kind="formula"
          token="node"
          name="node"
          meta="24.18.0 → 24.19.0"
          description="Required by three packages"
        >
          <template #actions><OnGetButton state="queued" /></template>
        </OnAppRow>
      </div>
    </StoryRow>
  </StorySection>
</template>
