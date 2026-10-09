<script setup lang="ts">
import { formatCount } from '@opennavo/shared';

// Catalog count-up from zero to actual value on viewport entry; screen readers read only the final value.
const props = defineProps<{ value: number; label: string }>();

const { locale } = useI18n();
const formattingLocale = computed(() => toAppLocale(locale.value));
const element = ref<HTMLElement>();
const current = useCountUp(element, () => props.value);
</script>

<template>
  <div
    ref="element"
    class="flex min-w-0 flex-col gap-8px rounded-big border border-solid border-line-subtle bg-surface-card px-20px py-18px"
  >
    <span class="text-title1 text-ink-primary md:text-display">
      <span aria-hidden="true">{{ formatCount(current, { locale: formattingLocale }) }}</span>
      <span class="sr-only">{{ formatCount(value, { locale: formattingLocale }) }}</span>
    </span>
    <span class="break-words text-13px leading-[1.5] text-ink-tertiary">{{ label }}</span>
  </div>
</template>
