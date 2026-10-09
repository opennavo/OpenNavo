<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';

export interface OnCardProps {
  /** Rendered element; clickable cards should use a with href or button. */
  as?: 'div' | 'section' | 'article' | 'li' | 'a' | 'button';
  href?: string;
  /** Hover border/background and pointer cursor. */
  interactive?: boolean;
  /** Padding 0 / 14 / 16 / 18. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Link component (NuxtLink/RouterLink); href passed as to, native a by default. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnCardProps>(), { as: 'div', padding: 'md', linkAs: 'a' });

defineSlots<{ default?: () => unknown }>();

const PADDING: Record<NonNullable<OnCardProps['padding']>, string> = {
  none: 'p-0',
  sm: 'p-14px',
  md: 'p-16px',
  lg: 'p-18px'
};

const tag = computed(() => (props.href !== undefined ? props.linkAs : props.as));

// Pass only defined link attributes; undefined href would override RouterLink's generated href.
const linkAttrs = computed(() => {
  if (props.href === undefined) return {};
  return props.linkAs === 'a' ? { href: props.href } : { to: props.href };
});

const classes = computed(() => [
  'm-0 box-border block rounded-big border border-solid border-line-subtle bg-surface-card text-left font-sans text-inherit no-underline',
  PADDING[props.padding],
  props.interactive
    ? 'cursor-pointer outline-none transition-colors duration-fast ease-standard hover:border-line-strong hover:bg-component-card-hover focus-visible:shadow-focus-ring'
    : ''
]);
</script>

<template>
  <component :is="tag" v-bind="linkAttrs" :type="tag === 'button' ? 'button' : undefined" :class="classes">
    <slot />
  </component>
</template>
