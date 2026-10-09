<script setup lang="ts">
defineProps<{ title: string; spec: string; description?: string }>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <section class="flex flex-col gap-16px rounded-big border border-solid border-line-subtle bg-surface-base p-24px">
    <header class="flex items-baseline justify-between gap-12px">
      <h2 class="m-0 text-title2 text-ink-primary">{{ title }}</h2>
      <span class="text-caption text-ink-tertiary">{{ spec }}</span>
    </header>
    <p v-if="description" class="m-0 text-body-sm text-ink-secondary">{{ description }}</p>
    <slot />
  </section>
</template>
