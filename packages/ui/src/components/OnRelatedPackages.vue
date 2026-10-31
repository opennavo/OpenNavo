<script setup lang="ts">
import type { Component } from 'vue';
import OnAppIcon from './OnAppIcon.vue';
import type { OnRelatedPackage } from './OnPackageOverview.vue';
const props = withDefaults(
  defineProps<{
    related: readonly OnRelatedPackage[];
    relatedTitle?: string;
    relatedMoreHref?: string;
    relatedMoreLabel?: string;
    linkAs?: string | Component;
  }>(),
  { linkAs: 'a' }
);
const linkAttrs = (href: string) => (props.linkAs === 'a' ? { href } : { to: href });
</script>

<template>
  <section v-if="related.length" class="mt-4px">
    <h2 class="m-0 text-headline text-ink-primary">{{ relatedTitle }}</h2>
    <ul class="m-0 mt-8px list-none p-0">
      <li
        v-for="pkg in related"
        :key="pkg.key"
        class="relative flex items-center gap-10px border-t border-t-solid border-line-subtle py-8px first:border-t-0"
      >
        <OnAppIcon
          :kind="pkg.kind"
          :token="pkg.token"
          :name="pkg.name"
          :src="pkg.src"
          :variants="pkg.variants"
          :accent="pkg.accent"
          :size="32"
        />
        <span class="min-w-0 flex-1">
          <component
            :is="linkAs"
            v-bind="linkAttrs(pkg.href)"
            class="on-stretched block truncate text-12.5px font-600 text-ink-primary no-underline outline-none focus-visible:underline"
          >
            {{ pkg.name }}
          </component>
          <span v-if="pkg.description" class="block truncate text-11px text-ink-tertiary">{{ pkg.description }}</span>
        </span>
      </li>
    </ul>
    <component
      :is="linkAs"
      v-if="relatedMoreHref"
      v-bind="linkAttrs(relatedMoreHref)"
      class="mt-8px inline-flex text-12.5px font-600 text-ink-secondary no-underline hover:text-ink-primary"
      >{{ relatedMoreLabel }}</component
    >
  </section>
</template>
