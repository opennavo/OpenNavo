<script setup lang="ts">
import { computed, provide } from 'vue';
import { ON_UI_LOCALE } from '@opennavo/ui';

defineOptions({ name: 'UiPreview' });

// Public component preview: dark-only public UI uses the token page surface; built-in copy follows locale.
const props = withDefaults(defineProps<{ locale?: 'zh-CN' | 'en-US' }>(), { locale: 'en-US' });

provide(
  ON_UI_LOCALE,
  computed(() => props.locale)
);
</script>

<template>
  <div class="rounded-panel bg-surface-page p-16px text-ink-primary">
    <slot />
  </div>
</template>
