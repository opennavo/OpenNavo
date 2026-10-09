<script setup lang="ts">
import { OnToolbar } from '@opennavo/ui';

// Web toolbar (05 §11.2): shared Command-K search, locale selector right; browser supplies back/forward.
const { t } = useI18n();
const palette = useCommandPalette();
</script>

<template>
  <OnToolbar :search-label="t('nav.search')" search-shortcut="⌘K" @search="palette.open.value = true">
    <template #end>
      <LanguageSwitch />
    </template>
  </OnToolbar>
</template>
