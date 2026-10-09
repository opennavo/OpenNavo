<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { $t } from '@/locales';

defineOptions({
  name: 'PagePlaceholder'
});

// M1-12 route/menu skeleton placeholder: title from route translation key, contents implemented by the corresponding task.
const route = useRoute();
const title = computed(() => (route.meta.i18nKey ? $t(route.meta.i18nKey) : String(route.meta.title ?? '')));
</script>

<template>
  <NCard :bordered="false" :title="title" class="card-wrapper">
    <NEmpty :description="$t('page.placeholder')" />
  </NCard>
</template>

<style scoped></style>
