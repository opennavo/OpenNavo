<script setup lang="ts">
import type { Component } from 'vue';
import OnCard from './OnCard.vue';
import OnIcon from './OnIcon.vue';
import OnPageHeader from './OnPageHeader.vue';
import OnSkeleton from './OnSkeleton.vue';

// Shared category overview (08 §10.2, ADR-017): top-level icon/name/count/optional-description cards and child categories.
export interface OnCategoriesItem {
  key: string;
  name: string;
  /** lucide:* */
  icon: string;
  /** Host-formatted count, e.g. 12 items. */
  count: string;
  description?: string | null;
  /** Subcategory name. */
  children: readonly string[];
  href: string;
}

export interface OnCategoriesViewProps {
  title: string;
  subtitle?: string;
  /** null means loading; show skeletons. */
  items: readonly OnCategoriesItem[] | null;
  linkAs?: string | Component;
}

withDefaults(defineProps<OnCategoriesViewProps>(), { linkAs: 'a' });

defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <div class="flex flex-col">
    <OnPageHeader :title="title" :subtitle="subtitle" />
    <!-- Default slot before grid for host states such as load failure. -->
    <slot />
    <div v-if="items === null" class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-12px" aria-hidden="true">
      <OnSkeleton v-for="index in 8" :key="index" height="88px" radius="big" />
    </div>
    <ul v-else class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-12px p-0">
      <li v-for="item in items" :key="item.key" class="flex">
        <OnCard as="a" :href="item.href" :link-as="linkAs" interactive padding="md" class="flex-1">
          <div class="flex items-center gap-12px">
            <span
              class="grid h-36px w-36px shrink-0 place-items-center rounded-default bg-surface-chip text-ink-secondary"
            >
              <OnIcon :name="item.icon" :size="18" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-14px font-600 text-ink-primary">{{ item.name }}</span>
              <span class="block text-12px text-ink-tertiary tabular-nums">{{ item.count }}</span>
            </span>
          </div>
          <p v-if="item.description" class="m-0 mt-10px line-clamp-2 text-12.5px leading-[1.5] text-ink-tertiary">
            {{ item.description }}
          </p>
          <p v-if="item.children.length" class="m-0 mt-10px truncate text-12px text-ink-tertiary">
            {{ item.children.join(' · ') }}
          </p>
        </OnCard>
      </li>
    </ul>
  </div>
</template>
