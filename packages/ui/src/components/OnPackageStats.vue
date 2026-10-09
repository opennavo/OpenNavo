<script setup lang="ts">
import OnStatTile from './OnStatTile.vue';

// Detail stats (08 §10.5, ADR-017): 30-day installs/rank, yearly installs, latest version/date, size, cadence.
// Host formats text; two columns on mobile.
export interface OnPackageStatsCell {
  key: string;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}

export interface OnPackageStatsProps {
  cells: readonly OnPackageStatsCell[];
  label: string;
}

defineProps<OnPackageStatsProps>();
</script>

<template>
  <section
    class="grid grid-cols-2 overflow-hidden rounded-big border border-solid border-line-subtle bg-surface-card md:grid-cols-5"
    :aria-label="label"
  >
    <OnStatTile
      v-for="(cell, index) in cells"
      :key="cell.key"
      size="md"
      :label="cell.label"
      :value="cell.value"
      :unit="cell.unit"
      :hint="cell.hint"
      class="border-line-subtle px-18px py-14px md:border-l md:border-l-solid"
      :class="index === 0 ? 'md:border-l-0' : ''"
    />
  </section>
</template>
