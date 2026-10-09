<script setup lang="ts">
defineProps<{ label: string }>();
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div class="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-16px">
    <span class="text-label text-ink-tertiary">{{ label }}</span>
    <div class="flex flex-wrap items-center gap-12px">
      <slot />
    </div>
  </div>
</template>
