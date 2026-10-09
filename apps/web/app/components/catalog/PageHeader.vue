<script setup lang="ts">
// List page header: title1 heading, description, count on the right.
defineProps<{ title: string; description?: string | null; meta?: string }>();

defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <header class="flex flex-col gap-8px">
    <slot />
    <div class="flex flex-wrap items-baseline gap-x-12px gap-y-4px">
      <h1 class="m-0 text-title1 text-ink-primary">{{ title }}</h1>
      <span v-if="meta" class="text-13px text-ink-tertiary tabular-nums">{{ meta }}</span>
    </div>
    <p v-if="description" class="m-0 max-w-720px text-14px leading-[1.6] text-ink-secondary">{{ description }}</p>
  </header>
</template>
