<script setup lang="ts">
import { computed } from 'vue';

export type OnSkeletonRadius = 'tiny' | 'small' | 'default' | 'big' | 'huge' | 'full' | 'app-icon';

export interface OnSkeletonProps {
  /** CSS length, fills by default. */
  width?: string;
  /** CSS length. */
  height?: string;
  /** Match target element's radius. */
  radius?: OnSkeletonRadius;
  /** Multiline text skeleton; last line is 60% wide. */
  lines?: number;
}

const props = withDefaults(defineProps<OnSkeletonProps>(), { width: '100%', height: '14px', radius: 'small' });

const RADIUS: Record<OnSkeletonRadius, string> = {
  tiny: 'rounded-tiny',
  small: 'rounded-small',
  default: 'rounded-default',
  big: 'rounded-big',
  huge: 'rounded-huge',
  full: 'rounded-full',
  'app-icon': 'rounded-app-icon'
};

const rows = computed(() => Math.max(1, props.lines ?? 1));
</script>

<template>
  <span class="flex flex-col gap-8px" :style="{ width }" aria-hidden="true">
    <span
      v-for="row in rows"
      :key="row"
      class="on-skeleton block"
      :class="RADIUS[radius]"
      :style="{ height, width: lines && row === rows && rows > 1 ? '60%' : '100%' }"
    ></span>
  </span>
</template>

<style>
/* Shimmer: cardAlt base, raised highlight, 1.4-second linear loop; base.css stops it for reduced motion. */
.on-skeleton {
  background: linear-gradient(
    90deg,
    var(--on-surface-card-alt) 25%,
    var(--on-surface-raised) 50%,
    var(--on-surface-card-alt) 75%
  );
  background-size: 200% 100%;
  animation: on-skeleton-shimmer 1.4s linear infinite;
}

@keyframes on-skeleton-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
</style>
