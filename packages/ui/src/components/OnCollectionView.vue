<script setup lang="ts">
import type { Component } from 'vue';
import type { PackageKind } from '@opennavo/shared';
import OnAppRow from './OnAppRow.vue';
import OnBreadcrumb from './OnBreadcrumb.vue';
import type { OnBreadcrumbItem } from './OnBreadcrumb.vue';
import OnPageHeader from './OnPageHeader.vue';
import OnSkeleton from './OnSkeleton.vue';

// Collection details (ADR-017): breadcrumbs, heading/description/actions (desktop install collection; web add all/export),
// body slot using separate @opennavo/ui/markdown renderer, then items preferring recommendations over summaries.
export interface OnCollectionEntry {
  key: string;
  kind: PackageKind;
  token: string;
  name: string;
  src?: string | null;
  accent?: string | null;
  description?: string | null;
  href: string;
}

export interface OnCollectionViewProps {
  breadcrumb: readonly OnBreadcrumbItem[];
  /** null means loading/failure: breadcrumbs/default slot only, plus skeletons while loading. */
  title: string | null;
  loading?: boolean;
  subtitle?: string | null;
  /** Caption below description, e.g. web item count/update date. */
  meta?: string;
  entries: readonly OnCollectionEntry[];
  linkAs?: string | Component;
}

withDefaults(defineProps<OnCollectionViewProps>(), { loading: false, linkAs: 'a' });

defineSlots<{
  actions?: () => unknown;
  body?: () => unknown;
  /** Button to the right of each item. */
  action?: (props: { entry: OnCollectionEntry }) => unknown;
  /** After heading: offline/errors/confirmation. */
  default?: () => unknown;
}>();
</script>

<template>
  <div class="flex flex-col">
    <OnBreadcrumb class="pt-6px" :items="breadcrumb" :link-as="linkAs" />
    <slot />
    <template v-if="title !== null">
      <OnPageHeader :title="title" :subtitle="subtitle ?? undefined">
        <p v-if="meta" class="m-0 mt-6px text-12.5px text-ink-tertiary">{{ meta }}</p>
        <template v-if="$slots.actions" #actions>
          <slot name="actions" />
        </template>
      </OnPageHeader>
      <div v-if="$slots.body" class="mb-20px">
        <slot name="body" />
      </div>
      <ul class="m-0 list-none rounded-big border border-solid border-line-subtle p-0">
        <li
          v-for="entry in entries"
          :key="entry.key"
          class="border-t border-t-solid border-line-subtle px-14px first:border-t-0"
        >
          <OnAppRow
            :kind="entry.kind"
            :token="entry.token"
            :name="entry.name"
            :src="entry.src"
            :accent="entry.accent"
            :description="entry.description"
            :href="entry.href"
            :link-as="linkAs"
          >
            <template v-if="$slots.action" #actions>
              <slot name="action" :entry="entry" />
            </template>
          </OnAppRow>
        </li>
      </ul>
    </template>
    <div v-else-if="loading" class="flex flex-col gap-12px pt-20px" aria-hidden="true">
      <OnSkeleton height="34px" width="40%" />
      <OnSkeleton :lines="2" />
      <OnSkeleton height="280px" radius="big" />
    </div>
  </div>
</template>
