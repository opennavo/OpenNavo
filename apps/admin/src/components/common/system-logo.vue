<script setup lang="ts">
import { computed, useId } from 'vue';
import { LOGO, logoInlineShift } from '@opennavo/shared';
import { useThemeStore } from '@/store/modules/theme';

defineOptions({
  name: 'SystemLogo'
});

interface Props {
  /** Actual display size, selecting small geometry at 32 px or below. */
  size?: number;
  /** Inline with a heading: center N with text (08 §2); omit for standalone logos. */
  inline?: boolean;
}

const props = withDefaults(defineProps<Props>(), { size: 32 });
const geometry = computed(() => (props.size <= 32 ? LOGO.small : LOGO));

// Multiple logos may share a page; gradient IDs must be unique.
const id = useId();
const themeStore = useThemeStore();
// Warm-white Polaris disappears on light backgrounds; use an amber gradient in light theme.
const starGradient = computed(() => (themeStore.darkMode ? LOGO.innerGradient : LOGO.innerGradientOnLight));
// Viewbox centers N plus star, leaving N lower; shift upward inline to align N with text.
const shift = computed(() => (props.inline ? { transform: logoInlineShift(geometry.value.nCenterOffset) } : undefined));
</script>

<template>
  <svg :viewBox="geometry.viewBox" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" :style="shift">
    <defs>
      <linearGradient :id="`${id}-outer`" x1="0" y1="0" x2="1" y2="1">
        <stop v-for="stop in LOGO.outerGradient" :key="stop.offset" :offset="stop.offset" :stop-color="stop.color" />
      </linearGradient>
      <linearGradient :id="`${id}-inner`" x1="0" y1="0" x2="1" y2="1">
        <stop v-for="stop in starGradient" :key="stop.offset" :offset="stop.offset" :stop-color="stop.color" />
      </linearGradient>
    </defs>
    <path :fill="`url(#${id}-outer)`" :d="geometry.outerPath" />
    <path :fill="`url(#${id}-inner)`" :d="geometry.innerPath" />
  </svg>
</template>

<style scoped></style>
