<script setup lang="ts">
import { OnToggle } from '@opennavo/ui';

// Web-only Show disabled filter (08 §10.2) in the shared list's filters slot.
const model = defineModel<boolean>({ required: true });

const { t } = useI18n();
const toggleId = useId();
</script>

<template>
  <span class="inline-flex items-center gap-8px text-13px text-ink-secondary">
    <OnToggle v-model="model" :aria-labelledby="toggleId" />
    <span :id="toggleId">{{ t('catalog.showDisabled') }}</span>
  </span>
</template>
