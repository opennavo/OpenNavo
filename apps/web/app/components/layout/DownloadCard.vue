<script setup lang="ts">
import { OnIcon, OnLogo } from '@opennavo/ui';

// OpenNavo for Mac sidebar card (05 §11.2): matches desktop Homebrew status-card dimensions, shows requirements, links entirely to download.
const { t } = useI18n();
const localePath = useLocalePath();
</script>

<template>
  <NuxtLink
    :to="localePath('/download')"
    class="mx-2px flex items-center gap-9px rounded-default border border-solid border-line-subtle bg-component-search-bg px-9px py-8px no-underline outline-none transition-colors duration-fast hover:border-line-default focus-visible:shadow-focus-ring"
  >
    <!-- Title already contains the brand; the logo is decorative. -->
    <span class="flex shrink-0" aria-hidden="true"><OnLogo :size="24" /></span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="break-words text-12.5px font-600 leading-snug text-ink-primary">{{ t('sidebar.appTitle') }}</span>
      <span class="break-words text-11px leading-snug text-ink-tertiary">{{ t('sidebar.appHint') }}</span>
    </span>
    <span class="flex shrink-0 text-ink-secondary">
      <OnIcon name="download" :size="15" :label="t('nav.download')" />
    </span>
  </NuxtLink>
</template>
