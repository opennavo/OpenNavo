<script setup lang="ts">
import { computed } from 'vue';
import { useUiMessages } from '../composables/locale';

export type GetState = 'get' | 'open' | 'installed' | 'update' | 'queued' | 'running' | 'unavailable';

export interface OnGetButtonProps {
  state: GetState;
  /** 0–100 when running; omitted means indeterminate spinner. */
  progress?: number;
  /** Override default copy, e.g. web Get or Update to 1.140.0. */
  label?: string;
}

const props = defineProps<OnGetButtonProps>();

const emit = defineEmits<{
  /** Click in get/open/update states. */
  click: [event: MouseEvent];
  /** Click while running; hover shows Stop square. */
  cancel: [event: MouseEvent];
}>();

const messages = useUiMessages();

// Only these three states are clickable; other states render noninteractive elements with readable text.
const INTERACTIVE: ReadonlySet<GetState> = new Set(['get', 'open', 'update']);

const STYLE: Record<GetState, string> = {
  get: 'border-transparent bg-surface-chip text-ink-primary hover:bg-button-secondary-hover',
  open: 'border-line-default bg-transparent text-ink-secondary hover:border-line-strong hover:text-ink-primary',
  installed: 'border-line-default bg-transparent text-ink-secondary',
  update: 'on-get-update border-transparent bg-accent-salmon-subtle text-brand-salmon',
  queued: 'border-transparent bg-surface-chip text-ink-primary opacity-60',
  running: 'group border-transparent bg-transparent',
  unavailable: 'border-transparent bg-button-disabled-bg text-button-disabled-text'
};

const text = computed(
  () => props.label ?? messages.value.getButton[props.state === 'running' ? 'cancel' : props.state]
);

const percent = computed(() =>
  props.progress === undefined ? undefined : Math.round(Math.min(100, Math.max(0, props.progress)))
);

// 22 px ring: radius 9.25, stroke 2.5.
const RADIUS = 9.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const dashOffset = computed(() => CIRCUMFERENCE * (1 - (percent.value ?? 25) / 100));

const classes = computed(() => [
  'm-0 box-border inline-flex h-26px min-w-56px select-none items-center justify-center whitespace-nowrap rounded-full border border-solid px-12px font-sans text-12px font-600 outline-none',
  'transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring',
  STYLE[props.state]
]);
</script>

<template>
  <button v-if="state === 'running'" type="button" :class="classes" :aria-label="text" @click="emit('cancel', $event)">
    <span
      class="relative inline-flex h-22px w-22px items-center justify-center"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="percent"
    >
      <svg
        viewBox="0 0 22 22"
        class="absolute inset-0 h-22px w-22px -rotate-90"
        :class="percent === undefined ? 'on-get-indeterminate' : ''"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" :r="RADIUS" fill="none" stroke-width="2.5" class="stroke-accent-coral-subtle" />
        <circle
          cx="11"
          cy="11"
          :r="RADIUS"
          fill="none"
          stroke-width="2.5"
          stroke-linecap="round"
          class="on-get-progress stroke-brand-coral"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="dashOffset"
        />
      </svg>
      <span
        class="h-8px w-8px rounded-tiny bg-brand-coral opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
      ></span>
    </span>
  </button>
  <button v-else-if="INTERACTIVE.has(state)" type="button" :class="classes" @click="emit('click', $event)">
    {{ text }}
  </button>
  <span v-else :class="classes">{{ text }}</span>
</template>

<style>
.on-get-update:hover {
  background-color: color-mix(in srgb, var(--on-brand-salmon) 18%, transparent);
}

.on-get-progress {
  transition: stroke-dashoffset var(--on-motion-duration-slow) var(--on-motion-easing-standard);
}

.on-get-indeterminate {
  animation: on-get-spin 1s linear infinite;
}

@keyframes on-get-spin {
  from {
    transform: rotate(-90deg);
  }
  to {
    transform: rotate(270deg);
  }
}
</style>
