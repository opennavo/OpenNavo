<script setup lang="ts" generic="T extends string">
import { computed, nextTick, ref } from 'vue';
import type { Component } from 'vue';
import { isRovingKey, nextRovingIndex } from '../composables/roving';
import type { OnTabItem } from '../types';

export interface OnTabsProps<V extends string> {
  modelValue: V;
  items: readonly OnTabItem<V>[];
  ariaLabel?: string;
  /** Link-mode component such as NuxtLink; native a by default, without component-owned routing. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnTabsProps<T>>(), { linkAs: 'a' });

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

// Any href activates web link mode; otherwise desktop same-page tablist.
const isLinkMode = computed(() => props.items.some(item => item.href !== undefined));

const tabs = ref<HTMLElement[]>([]);

const itemClass = (item: OnTabItem<T>) => [
  'relative m-0 box-border inline-flex h-38px items-center whitespace-nowrap rounded-tiny border-none bg-transparent p-0 font-sans text-13.5px font-500 no-underline outline-none',
  'transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring',
  item.value === props.modelValue
    ? 'text-ink-primary'
    : item.disabled
      ? 'cursor-not-allowed text-ink-disabled'
      : 'text-ink-tertiary hover:text-ink-secondary'
];

// Native a uses href; routers use to, avoiding undefined attributes overriding generated href.
function linkAttrs(item: OnTabItem<T>) {
  if (item.disabled || item.href === undefined) return {};
  return props.linkAs === 'a' ? { href: item.href } : { to: item.href };
}

function select(item: OnTabItem<T>) {
  if (!item.disabled && item.value !== props.modelValue) emit('update:modelValue', item.value);
}

async function onKeydown(event: KeyboardEvent) {
  if (isLinkMode.value || !isRovingKey(event.key)) return;
  event.preventDefault();
  const current = props.items.findIndex(item => item.value === props.modelValue);
  const next = nextRovingIndex(
    event.key,
    current,
    props.items.map(item => !item.disabled)
  );
  const item = props.items[next];
  if (!item) return;
  select(item);
  await nextTick();
  tabs.value[next]?.focus();
}
</script>

<template>
  <nav
    v-if="isLinkMode"
    :aria-label="ariaLabel"
    class="flex min-w-0 flex-wrap items-end gap-x-26px border-b border-b-solid border-line-subtle px-4px"
  >
    <component
      :is="item.disabled ? 'span' : linkAs"
      v-for="item in items"
      :key="item.value"
      v-bind="linkAttrs(item)"
      :aria-current="item.value === modelValue ? 'page' : undefined"
      :aria-disabled="item.disabled ? 'true' : undefined"
      :class="itemClass(item)"
      @click="select(item)"
    >
      {{ item.label }}
      <span v-if="item.count !== undefined" class="ml-5px text-11.5px text-ink-tertiary tabular-nums">
        {{ item.count }}
      </span>
      <span
        v-if="item.value === modelValue"
        class="absolute inset-x-0 -bottom-1px h-2px rounded-full bg-component-tab-indicator"
        aria-hidden="true"
      ></span>
    </component>
  </nav>
  <div
    v-else
    role="tablist"
    :aria-label="ariaLabel"
    class="flex min-w-0 flex-wrap items-end gap-x-26px border-b border-b-solid border-line-subtle px-4px"
    @keydown="onKeydown"
  >
    <button
      v-for="item in items"
      :key="item.value"
      ref="tabs"
      type="button"
      role="tab"
      :aria-selected="item.value === modelValue ? 'true' : 'false'"
      :aria-controls="item.controls"
      :tabindex="item.value === modelValue ? 0 : -1"
      :disabled="item.disabled"
      :class="itemClass(item)"
      @click="select(item)"
    >
      {{ item.label }}
      <span v-if="item.count !== undefined" class="ml-5px text-11.5px text-ink-tertiary tabular-nums">
        {{ item.count }}
      </span>
      <span
        v-if="item.value === modelValue"
        class="absolute inset-x-0 -bottom-1px h-2px rounded-full bg-component-tab-indicator"
        aria-hidden="true"
      ></span>
    </button>
  </div>
</template>
