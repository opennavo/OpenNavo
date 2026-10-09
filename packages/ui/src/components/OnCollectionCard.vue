<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import { interpolatePlural } from '@opennavo/shared';
import type { PackageKind } from '@opennavo/shared';
import OnAppIcon from './OnAppIcon.vue';
import OnButton from './OnButton.vue';
import { useUiLocale, useUiMessages } from '../composables/locale';

export interface OnCollectionIcon {
  /** Package metadata enables letter/terminal fallback without icons; URL-only missing images use placeholders. */
  kind?: PackageKind;
  token?: string;
  name?: string;
  src?: string | null;
  accent?: string | null;
}

export interface OnCollectionCardProps {
  title: string;
  subtitle?: string | null;
  /** Item count for View all 12 apps button copy. */
  count: number;
  /** First five item icons. */
  icons?: readonly OnCollectionIcon[];
  href: string;
  /** Link component (NuxtLink/RouterLink), native a by default. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnCollectionCardProps>(), { icons: () => [], linkAs: 'a' });

const messages = useUiMessages();
const locale = useUiLocale();

const stack = computed(() => props.icons.slice(0, 5));
</script>

<template>
  <article
    class="on-collection box-border flex min-w-0 flex-col rounded-big border border-solid border-line-subtle p-14px font-sans"
  >
    <div v-if="stack.length" class="mb-12px flex" aria-hidden="true">
      <span v-for="(icon, index) in stack" :key="index" class="on-collection-icon -mr-8px inline-flex rounded-app-icon">
        <OnAppIcon
          v-if="icon.kind && icon.token && icon.name"
          :kind="icon.kind"
          :token="icon.token"
          :name="icon.name"
          :src="icon.src"
          :accent="icon.accent"
          :size="30"
        />
        <img
          v-else-if="icon.src"
          :src="icon.src"
          alt=""
          width="30"
          height="30"
          loading="lazy"
          class="block h-30px w-30px rounded-app-icon object-cover"
        />
        <span v-else class="block h-30px w-30px rounded-app-icon bg-surface-raised"></span>
      </span>
    </div>
    <h3 class="m-0 text-14px font-600 text-ink-primary">{{ title }}</h3>
    <p v-if="subtitle" class="m-0 mt-4px text-12px leading-[1.5] text-ink-tertiary">{{ subtitle }}</p>
    <!-- Equal-height grid cards pin buttons to bottom with at least 12 px spacing from body. -->
    <div class="mt-auto pt-12px">
      <OnButton class="!h-auto min-h-34px py-6px" variant="secondary" block :href="href" :link-as="linkAs">
        <span class="whitespace-normal text-center">{{
          interpolatePlural(messages.collection.viewAll, { count }, count, locale)
        }}</span>
      </OnButton>
    </div>
  </article>
</template>

<style>
.on-collection {
  background: linear-gradient(160deg, var(--on-component-collection-from), var(--on-component-collection-to) 70%);
}

.on-collection-icon {
  box-shadow: 0 0 0 2px var(--on-component-collection-ring);
}
</style>
