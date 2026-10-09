<script setup lang="ts">
import { computed } from 'vue';
import { LOGO, logoInlineShift } from '@opennavo/shared';

export interface OnBadgeProps {
  /** Provided value makes a count badge, e.g. Updates 6; otherwise a text badge, e.g. Featured this week. */
  count?: number;
  /** Above the limit show 99+. */
  max?: number;
  /** Accessible count label, e.g. six available updates. */
  label?: string;
  /** Add a 13 px logo Polaris after text (08 §2). */
  star?: boolean;
}

const props = withDefaults(defineProps<OnBadgeProps>(), { max: 99 });

defineSlots<{ default?: () => unknown }>();

const countText = computed(() => {
  if (props.count === undefined) return '';
  return props.count > props.max ? `${props.max}+` : String(Math.max(0, props.count));
});

// The long top ray stretches bounds; center the star with text by area centroid.
const starShift = logoInlineShift(LOGO.starCenterOffset);
</script>

<template>
  <span
    v-if="count !== undefined"
    class="box-border inline-flex h-18px min-w-20px items-center justify-center rounded-full bg-brand-coral px-6px text-11px font-700 leading-none text-ink-on-accent tabular-nums"
    :aria-label="label"
  >
    {{ countText }}
  </span>
  <span
    v-else
    class="box-border inline-flex h-26px items-center gap-6px whitespace-nowrap rounded-small bg-accent-salmon-subtle px-10px text-12.5px font-500 text-brand-salmon"
  >
    <slot />
    <svg
      v-if="star"
      :viewBox="LOGO.starViewBox"
      class="h-13px w-13px shrink-0"
      :style="{ transform: starShift }"
      aria-hidden="true"
    >
      <path :d="LOGO.innerPath" fill="currentColor" />
    </svg>
  </span>
</template>
