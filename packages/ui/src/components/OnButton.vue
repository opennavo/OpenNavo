<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import OnIcon from './OnIcon.vue';

export type OnButtonVariant = 'primary' | 'secondary' | 'accent' | 'ghost' | 'danger';
export type OnButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface OnButtonProps {
  variant?: OnButtonVariant;
  /** Heights 26 / 28 / 34 / 40. */
  size?: OnButtonSize;
  /** round gives a pill shape. */
  shape?: 'default' | 'round';
  /** lucide:* icon before text. */
  icon?: string;
  /** Square button; ariaLabel is also required. */
  iconOnly?: boolean;
  ariaLabel?: string;
  /** Show spinner and disable. */
  loading?: boolean;
  disabled?: boolean;
  /** Fill available width. */
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  /** Render as a link when provided. */
  href?: string;
  target?: string;
  rel?: string;
  /** Link component (NuxtLink/RouterLink), href passed as to; native a by default. Components never read routes. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnButtonProps>(), {
  variant: 'secondary',
  size: 'md',
  shape: 'default',
  type: 'button',
  linkAs: 'a'
});

const emit = defineEmits<{ click: [event: MouseEvent] }>();

defineSlots<{ default?: () => unknown }>();

const SIZE: Record<OnButtonSize, string> = {
  xs: 'h-26px px-11px gap-6px text-12px',
  sm: 'h-28px px-12px gap-6px text-12.5px',
  md: 'h-34px px-16px gap-7px text-13px',
  lg: 'h-40px px-18px gap-8px text-13.5px'
};

const ICON_ONLY: Record<OnButtonSize, string> = {
  xs: 'h-26px w-26px',
  sm: 'h-28px w-28px',
  md: 'h-34px w-34px',
  lg: 'h-40px w-40px'
};

const ICON_SIZE: Record<OnButtonSize, number> = { xs: 14, sm: 14, md: 15, lg: 15 };

// Each variant supplies its border color, avoiding base-class conflicts.
const VARIANT: Record<OnButtonVariant, string> = {
  primary:
    'border-transparent bg-button-primary-bg text-button-primary-text hover:bg-button-primary-hover active:bg-button-primary-pressed',
  secondary:
    'border-transparent bg-button-secondary-bg text-button-secondary-text hover:bg-button-secondary-hover active:bg-button-secondary-pressed',
  accent:
    'border-transparent bg-button-accent-bg text-button-accent-text hover:bg-button-accent-hover active:bg-button-accent-pressed',
  ghost: 'border-line-default bg-transparent text-ink-secondary hover:border-line-strong hover:text-ink-primary',
  danger: 'on-button-danger border-transparent bg-status-danger-subtle text-status-danger'
};

const DISABLED = 'border-transparent bg-button-disabled-bg text-button-disabled-text cursor-not-allowed';

const inactive = computed(() => props.disabled || props.loading);

const classes = computed(() => [
  'm-0 box-border inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap border border-solid font-sans font-600 no-underline outline-none',
  'transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring',
  props.shape === 'round' ? 'rounded-full' : 'rounded-default',
  props.iconOnly ? ICON_ONLY[props.size] : SIZE[props.size],
  inactive.value ? DISABLED : VARIANT[props.variant],
  props.block ? 'w-full' : ''
]);

const isLink = computed(() => props.href !== undefined);

// Native a uses href, removed when disabled; routers use to with aria-disabled and prevented clicks.
const linkAttrs = computed(() => {
  if (props.linkAs !== 'a') return { to: props.href };
  return inactive.value ? {} : { href: props.href };
});

function onClick(event: MouseEvent) {
  if (inactive.value) {
    event.preventDefault();
    return;
  }
  emit('click', event);
}
</script>

<template>
  <component
    :is="linkAs"
    v-if="isLink"
    v-bind="linkAttrs"
    :class="classes"
    :target="target"
    :rel="rel"
    :aria-label="ariaLabel"
    :aria-disabled="inactive ? 'true' : undefined"
    :aria-busy="loading ? 'true' : undefined"
    @click="onClick"
  >
    <span v-if="loading" class="on-spinner" aria-hidden="true"></span>
    <OnIcon v-else-if="icon" :name="icon" :size="ICON_SIZE[size]" />
    <slot v-if="!iconOnly" />
  </component>
  <button
    v-else
    :type="type"
    :class="classes"
    :disabled="inactive"
    :aria-label="ariaLabel"
    :aria-busy="loading ? 'true' : undefined"
    @click="onClick"
  >
    <span v-if="loading" class="on-spinner" aria-hidden="true"></span>
    <OnIcon v-else-if="icon" :name="icon" :size="ICON_SIZE[size]" />
    <slot v-if="!iconOnly" />
  </button>
</template>

<style>
.on-button-danger:hover {
  background-color: color-mix(in srgb, var(--on-status-danger) 16%, transparent);
}

.on-button-danger:active {
  background-color: color-mix(in srgb, var(--on-status-danger) 22%, transparent);
}

.on-spinner {
  width: 14px;
  height: 14px;
  flex: none;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--on-radius-full);
  animation: on-spin 0.8s linear infinite;
}

@keyframes on-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
