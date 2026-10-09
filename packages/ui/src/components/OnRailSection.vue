<script setup lang="ts">
// Statistics-rail section: heading, subtitle, content.
export interface OnRailSectionProps {
  title: string;
  subtitle?: string;
}

defineProps<OnRailSectionProps>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <section class="flex flex-col gap-12px">
    <header class="flex flex-col gap-2px">
      <h2 class="m-0 text-headline text-ink-primary">{{ title }}</h2>
      <p v-if="subtitle" class="m-0 text-12.5px text-ink-tertiary">{{ subtitle }}</p>
    </header>
    <slot />
  </section>
</template>
