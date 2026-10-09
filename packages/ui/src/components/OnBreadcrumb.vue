<script setup lang="ts">
import type { Component } from 'vue';
import OnIcon from './OnIcon.vue';
import { useUiMessages } from '../composables/locale';

export interface OnBreadcrumbItem {
  label: string;
  /** Unneeded for the last/current item. */
  href?: string;
}

export interface OnBreadcrumbProps {
  items: readonly OnBreadcrumbItem[];
  /** Link component (NuxtLink/RouterLink), native a by default. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnBreadcrumbProps>(), { linkAs: 'a' });

const messages = useUiMessages();

const linkAttrs = (href: string) => (props.linkAs === 'a' ? { href } : { to: href });
</script>

<template>
  <nav :aria-label="messages.nav.breadcrumb">
    <ol class="m-0 flex min-w-0 list-none items-center gap-6px p-0 text-13px">
      <li v-for="(item, index) in items" :key="index" class="flex min-w-0 items-center gap-6px">
        <OnIcon v-if="index > 0" name="lucide:chevron-right" :size="12" class="text-ink-tertiary" />
        <span v-if="index === items.length - 1" aria-current="page" class="truncate font-500 text-ink-primary">{{
          item.label
        }}</span>
        <component
          :is="linkAs"
          v-else-if="item.href"
          v-bind="linkAttrs(item.href)"
          class="truncate text-ink-tertiary no-underline transition-colors duration-fast hover:text-ink-primary"
        >
          {{ item.label }}
        </component>
        <span v-else class="truncate text-ink-tertiary">{{ item.label }}</span>
      </li>
    </ol>
  </nav>
</template>
