<script setup lang="ts">
import { computed } from 'vue';
import { useUiMessages } from '../composables/locale';

export interface OnProgressMeterProps {
  /** 0–100; omitted means indeterminate. */
  value?: number | null;
  /** md height six; sm height four for menu bar. */
  size?: 'md' | 'sm';
  /** Accessible name, e.g. Updating Docker Desktop. */
  label?: string;
}

const props = withDefaults(defineProps<OnProgressMeterProps>(), { size: 'md' });

const messages = useUiMessages();

const determinate = computed(() => typeof props.value === 'number' && Number.isFinite(props.value));
const percent = computed(() => (determinate.value ? Math.min(100, Math.max(0, props.value as number)) : 0));
</script>

<template>
  <div class="flex w-full items-center gap-8px">
    <div
      class="relative min-w-0 flex-1 overflow-hidden rounded-full bg-accent-coral-subtle"
      :class="size === 'md' ? 'h-6px' : 'h-4px'"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="determinate ? Math.round(percent) : undefined"
      :aria-valuetext="determinate ? undefined : messages.progress.busy"
      :aria-label="label"
    >
      <div
        v-if="determinate"
        class="on-meter-fill h-full rounded-full bg-brand-coral"
        :style="{ width: `${percent}%` }"
      ></div>
      <div v-else class="on-meter-indeterminate absolute top-0 h-full w-30% rounded-full bg-brand-coral"></div>
    </div>
    <!-- Reduced motion uses a static bar and text for indeterminate progress (08 §8.16). -->
    <span v-if="!determinate" class="on-meter-busy shrink-0 text-11px text-ink-tertiary" aria-hidden="true">{{
      messages.progress.busy
    }}</span>
  </div>
</template>

<style>
.on-meter-fill {
  transition: width var(--on-motion-duration-slow) var(--on-motion-easing-standard);
}

.on-meter-indeterminate {
  animation: on-meter-sweep 1.2s ease-in-out infinite alternate;
}

.on-meter-busy {
  display: none;
}

@keyframes on-meter-sweep {
  from {
    left: 0;
  }
  to {
    left: 70%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .on-meter-indeterminate {
    left: 0;
    width: 100%;
    opacity: 0.45;
    animation: none;
  }

  .on-meter-busy {
    display: inline;
  }
}
</style>
