<script setup lang="ts">
// Full-width mockup hero glow (08 §10.1, §10.14): soft 1100-wide glow, dashed concentric circles, bottom 260 px fade to page surface.
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <section class="glow-cover relative overflow-hidden">
    <div class="glow-cover-glow pointer-events-none absolute left-1/2 rounded-full" aria-hidden="true"></div>
    <svg
      class="glow-cover-rings pointer-events-none absolute left-1/2"
      width="1500"
      height="1300"
      viewBox="0 0 1500 1300"
      fill="none"
      aria-hidden="true"
    >
      <g class="glow-cover-ring">
        <circle cx="750" cy="1020" r="260" />
        <circle cx="750" cy="1020" r="420" />
        <circle cx="750" cy="1020" r="580" />
        <circle cx="750" cy="1020" r="740" />
      </g>
    </svg>
    <!-- Fade only glow/circles; positioned content later in document order appears above it. -->
    <div class="glow-cover-fade pointer-events-none absolute inset-x-0 bottom-0" aria-hidden="true"></div>
    <div class="relative">
      <slot />
    </div>
  </section>
</template>

<style>
.glow-cover-glow {
  top: 180px;
  width: 1100px;
  height: 1100px;
  transform: translateX(-50%);
  background: var(--on-effect-cover-glow);
}

.glow-cover-rings {
  top: -120px;
  transform: translateX(-50%);
}

.glow-cover-ring {
  stroke: var(--on-effect-ring-stroke);
  stroke-dasharray: var(--on-effect-ring-dasharray);
}

.glow-cover-fade {
  height: 260px;
  background: linear-gradient(transparent, var(--on-surface-page));
}
</style>
