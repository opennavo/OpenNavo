<script setup lang="ts">
import OnIcon from './OnIcon.vue';

export interface OnEmptyProps {
  title: string;
  description?: string;
  /** lucide:*，48px，`text.disabled` */
  icon?: string;
}

withDefaults(defineProps<OnEmptyProps>(), { icon: 'lucide:inbox' });

defineSlots<{ actions?: () => unknown }>();
</script>

<template>
  <div class="flex flex-col items-center gap-8px px-24px py-40px text-center">
    <OnIcon :name="icon" :size="48" class="mb-6px text-ink-disabled" />
    <h3 class="m-0 text-15px font-600 text-ink-primary">{{ title }}</h3>
    <p v-if="description" class="m-0 max-w-420px text-13px leading-20px text-ink-secondary">{{ description }}</p>
    <div v-if="$slots.actions" class="mt-8px flex flex-wrap justify-center gap-10px">
      <slot name="actions" />
    </div>
  </div>
</template>
