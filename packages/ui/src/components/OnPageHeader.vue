<script setup lang="ts">
// Shared top-level header (mockups 05/06, ADR-017): 30/600 heading, description, actions right.
export interface OnPageHeaderProps {
  title: string;
  subtitle?: string;
}

defineProps<OnPageHeaderProps>();
defineSlots<{ actions?: () => unknown; default?: () => unknown }>();
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-16px pb-20px pt-14px">
    <div class="min-w-0">
      <h1 class="m-0 text-30px font-600 leading-[1.15] tracking-[-0.025em] text-ink-primary">{{ title }}</h1>
      <p v-if="subtitle" class="m-0 mt-8px text-14px text-ink-secondary">{{ subtitle }}</p>
      <slot />
    </div>
    <!-- Narrow mobile actions move below heading and wrap within the container without horizontal overflow. -->
    <div v-if="$slots.actions" class="flex max-w-full shrink-0 flex-wrap items-center gap-8px">
      <slot name="actions" />
    </div>
  </header>
</template>
