<script setup lang="ts">
import { OnIcon } from '@opennavo/ui';

// Landing feature section (08 §10.14): copy left/demo right, swapped with reverse; stack demo below on narrow screens; slot supplies demo.
withDefaults(
  defineProps<{ kicker: string; title: string; body: string; points?: readonly string[]; reverse?: boolean }>(),
  { points: () => [], reverse: false }
);

defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <section class="mx-auto box-border grid max-w-1240px items-center gap-40px px-24px lg:grid-cols-2 lg:gap-64px">
    <div class="flex flex-col gap-24px" :class="reverse ? 'lg:order-2' : ''" data-reveal>
      <LandingSectionHead :kicker="kicker" :title="title" :body="body" />
      <ul v-if="points.length" class="m-0 flex list-none flex-col gap-12px p-0">
        <li
          v-for="point in points"
          :key="point"
          class="flex items-start gap-10px text-14px leading-[1.6] text-ink-secondary"
        >
          <span
            class="mt-2px inline-flex h-18px w-18px shrink-0 items-center justify-center rounded-full bg-status-success-subtle text-status-success"
            aria-hidden="true"
          >
            <OnIcon name="check" :size="12" />
          </span>
          <span class="min-w-0">{{ point }}</span>
        </li>
      </ul>
    </div>
    <div class="min-w-0" :class="reverse ? 'lg:order-1' : ''" data-reveal style="--landing-delay: 120ms">
      <div
        class="landing-feature-stage relative box-border flex min-h-360px items-center justify-center overflow-hidden rounded-huge border border-solid border-line-subtle bg-surface-card px-20px py-32px md:px-40px md:py-48px"
      >
        <div class="landing-feature-glow pointer-events-none absolute rounded-full" aria-hidden="true"></div>
        <div class="relative w-full">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style>
/* Soft brand-violet glow behind demos, subtler than the hero. */
.landing-feature-glow {
  left: 50%;
  top: 50%;
  width: 640px;
  height: 640px;
  margin: -320px 0 0 -320px;
  background: var(--on-effect-cover-glow);
  opacity: 0.45;
}
</style>
