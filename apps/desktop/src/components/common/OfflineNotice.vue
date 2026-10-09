<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { OnOffline } from '@opennavo/ui';

// Top-of-page API-unavailable notice (08 §10.15); local catalog remains usable.
const { t } = useI18n();
</script>

<template>
  <OnOffline :title="t('offline.title')" :description="t('offline.description')" />
</template>
