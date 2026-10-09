<script setup lang="ts">
import type { Component } from 'vue';
import OnIcon from './OnIcon.vue';

// Detail notice (08 §10.5): disabled danger/deprecated warning, reason, replacement. For command-line replacements without details
// (ADR-018), omit replacementHref and display name only.
export interface OnPackageNoticeProps {
  tone: 'danger' | 'warning';
  text: string;
  replacementLabel?: string;
  replacementHref?: string;
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnPackageNoticeProps>(), { linkAs: 'a' });

const linkAttrs = (href: string) => (props.linkAs === 'a' ? { href } : { to: href });
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-8px rounded-default border border-solid px-14px py-10px text-13px"
    :class="
      tone === 'danger'
        ? 'border-status-danger bg-status-danger-subtle text-status-danger'
        : 'border-status-warning bg-status-warning-subtle text-status-warning'
    "
    role="note"
  >
    <OnIcon name="triangle-alert" :size="16" />
    <span>{{ text }}</span>
    <template v-if="replacementLabel">
      <component
        :is="linkAs"
        v-if="replacementHref"
        v-bind="linkAttrs(replacementHref)"
        class="font-600 text-ink-primary underline"
      >
        {{ replacementLabel }}
      </component>
      <span v-else class="font-600 text-ink-primary">{{ replacementLabel }}</span>
    </template>
  </div>
</template>
