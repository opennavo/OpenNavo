<script setup lang="ts">
import { $t } from '@/locales';

defineOptions({
  name: 'GlobalLogo'
});

interface Props {
  /** Whether to show the title */
  showTitle?: boolean;
}

withDefaults(defineProps<Props>(), {
  showTitle: true
});
</script>

<template>
  <RouterLink to="/" class="box-border w-full min-w-0 flex-center px-12px">
    <SystemLogo class="size-32px shrink-0 transition-transform duration-300 ease-in-out" :inline="showTitle" />
    <h2
      v-show="showTitle"
      class="min-w-0 whitespace-normal break-words pl-8px text-16px leading-18px text-primary font-bold transition duration-300 ease-in-out"
    >
      {{ $t('system.title') }}
    </h2>
  </RouterLink>
</template>

<style scoped></style>
