<script setup lang="ts">
import { OnIcon } from '@opennavo/ui';

// Borderless toolbar icon button (back/forward), 28×28 (mockup .tb .arrows).
defineProps<{ icon: string; label: string; disabled?: boolean }>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="m-0 box-border grid h-28px w-28px place-items-center rounded-small border-none bg-transparent p-0 text-ink-tertiary outline-none transition-colors duration-fast ease-standard hover:bg-surface-raised hover:text-ink-primary focus-visible:shadow-focus-ring disabled:cursor-default disabled:bg-transparent disabled:text-ink-disabled"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('click')"
  >
    <OnIcon :name="icon" :size="16" />
  </button>
</template>
