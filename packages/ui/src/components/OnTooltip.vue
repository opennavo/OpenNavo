<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

export interface OnTooltipProps {
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Show delay in milliseconds (08 §8.24: 400). */
  delay?: number;
  disabled?: boolean;
}

const props = withDefaults(defineProps<OnTooltipProps>(), { placement: 'top', delay: 400 });

defineSlots<{ default?: () => unknown }>();

const id = useId();
const root = ref<HTMLElement>();
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const PLACEMENT: Record<NonNullable<OnTooltipProps['placement']>, string> = {
  top: 'bottom-full left-1/2 mb-6px -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-6px -translate-x-1/2',
  left: 'right-full top-1/2 mr-6px -translate-y-1/2',
  right: 'left-full top-1/2 ml-6px -translate-y-1/2'
};

const placementClass = computed(() => PLACEMENT[props.placement]);

function show() {
  if (props.disabled || !props.content) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    open.value = true;
  }, props.delay);
}

function hide() {
  clearTimeout(timer);
  open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  // WCAG 1.4.13: Escape dismisses tooltips.
  if (event.key === 'Escape' && open.value) hide();
}

// Screen readers read tooltips through the trigger's aria-describedby.
function describeTrigger() {
  const trigger = root.value?.firstElementChild;
  if (!trigger || trigger.id === id) return;
  if (props.disabled || !props.content) trigger.removeAttribute('aria-describedby');
  else trigger.setAttribute('aria-describedby', id);
}

onMounted(describeTrigger);
watch(() => [props.disabled, props.content], describeTrigger);
watch(
  () => props.disabled,
  disabled => {
    if (disabled) hide();
  }
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <span
    ref="root"
    class="relative inline-flex"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @keydown="onKeydown"
  >
    <slot />
    <span
      :id="id"
      role="tooltip"
      class="absolute z-tooltip box-border w-max max-w-240px rounded-small border border-solid border-line-default bg-surface-control px-9px py-6px text-11.5px font-400 leading-16px text-ink-primary shadow-popover transition-opacity duration-fast"
      :class="[placementClass, open ? 'visible opacity-100' : 'invisible opacity-0']"
    >
      {{ content }}
    </span>
  </span>
</template>
