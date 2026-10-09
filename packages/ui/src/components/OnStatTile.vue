<script setup lang="ts">
export interface OnStatDelta {
  /** Formatted value, e.g. 12%. */
  value: string;
  direction: 'up' | 'down';
  /** Whether change is favorable determines color; arrows separately convey direction. */
  good: boolean;
}

export interface OnStatTileProps {
  /** Sentence case without colon, e.g. Installed. */
  label: string;
  /** Formatted numeric value. */
  value: string;
  /** Unit, e.g. GB or minutes ago. */
  unit?: string;
  /** Third-line description. */
  hint?: string;
  delta?: OnStatDelta;
  /** sm: standalone 2×2 rail tiles; md: detail-stat cell with outer dividers. */
  size?: 'sm' | 'md';
}

withDefaults(defineProps<OnStatTileProps>(), { size: 'sm' });
</script>

<template>
  <div
    class="box-border flex min-w-0 flex-col gap-2px"
    :class="
      size === 'sm'
        ? 'rounded-default border border-solid border-line-subtle bg-surface-card px-14px py-12px'
        : 'px-18px'
    "
  >
    <span class="break-words text-ink-tertiary" :class="size === 'sm' ? 'text-11px' : 'text-11.5px'">{{ label }}</span>
    <span class="flex min-w-0 flex-wrap items-baseline gap-6px">
      <span class="flex min-w-0 flex-wrap items-baseline gap-2px">
        <span class="break-words text-stat text-ink-primary">{{ value }}</span>
        <span v-if="unit" class="shrink-0 text-12px font-500 text-ink-tertiary">{{ unit }}</span>
      </span>
      <span
        v-if="delta"
        class="shrink-0 text-11px font-500 tabular-nums"
        :class="delta.good ? 'text-status-success' : 'text-status-danger'"
      >
        {{ delta.direction === 'up' ? '↑' : '↓' }} {{ delta.value }}
      </span>
    </span>
    <span v-if="hint" class="break-words text-11px text-ink-tertiary">{{ hint }}</span>
  </div>
</template>
