<script setup lang="ts">
import { OnIcon } from '@opennavo/ui';

// Privacy demo: three outward shield ripples in CSS; reduced motion freezes them.
</script>

<template>
  <div class="relative mx-auto grid h-150px w-150px place-items-center" aria-hidden="true">
    <span
      v-for="index in 3"
      :key="index"
      class="landing-pulse absolute inset-0 rounded-full border border-solid border-line-default"
      :style="{ animationDelay: `${(index - 1) * 1.1}s` }"
    ></span>
    <span
      class="relative grid h-64px w-64px place-items-center rounded-full bg-status-success-subtle text-status-success"
    >
      <OnIcon name="shield-check" :size="30" />
    </span>
  </div>
</template>

<style>
.landing-pulse {
  opacity: 0.35;
  transform: scale(0.8);
  animation: landing-pulse 3.3s var(--on-motion-easing-standard) infinite;
}

@keyframes landing-pulse {
  from {
    opacity: 0.9;
    transform: scale(0.45);
  }
  to {
    opacity: 0;
    transform: scale(1);
  }
}
</style>
