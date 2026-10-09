<script setup lang="ts">
import OnIcon from './OnIcon.vue';

export interface OnKeyValueItem {
  key: string;
  label: string;
  value: string;
  /** Monospace for tokens, commands, paths. */
  mono?: boolean;
  /** External link. */
  href?: string;
}

export interface OnKeyValueListProps {
  items: readonly OnKeyValueItem[];
}

defineProps<OnKeyValueListProps>();
</script>

<template>
  <dl class="m-0 flex flex-col">
    <div
      v-for="item in items"
      :key="item.key"
      class="flex min-w-0 items-center justify-between gap-16px border-b border-b-solid border-line-subtle py-9px last:border-b-0"
    >
      <dt class="shrink-0 whitespace-nowrap text-12.5px text-ink-tertiary">{{ item.label }}</dt>
      <dd
        class="m-0 min-w-0 truncate text-right text-12.5px font-500 text-ink-primary"
        :class="item.mono ? 'font-mono' : ''"
      >
        <a
          v-if="item.href"
          :href="item.href"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex max-w-full items-center gap-4px text-ink-primary no-underline hover:underline"
        >
          <span class="truncate">{{ item.value }}</span>
          <OnIcon name="lucide:arrow-up-right" :size="13" />
        </a>
        <template v-else>{{ item.value }}</template>
      </dd>
    </div>
  </dl>
</template>
