<script setup lang="ts">
import { OnAboutContent } from '@opennavo/ui';
import { unwrap } from '@opennavo/api';

// Prefer backend body content; retain basic language-resource copy when unconfigured/offline.
const { t, tm, rt, locale } = useI18n();
const api = useApi();
const { data: config } = await useAsyncData(
  () => `about:${locale.value}`,
  () => unwrap(api.GET('/config/client', { params: { query: { platform: 'web' } } }))
);

const sections = computed(() =>
  (['about', 'data', 'privacy', 'terms', 'contact'] as const).map(key => ({
    key,
    title: t(`about.${key}.title`),
    draft: key === 'privacy' || key === 'terms',
    paragraphs: (tm(`about.${key}.body`) as unknown[]).map(item => rt(item as Parameters<typeof rt>[0]))
  }))
);

usePageSeo({ title: () => t('about.metaTitle'), description: () => t('about.description') });
</script>

<template>
  <div class="mx-auto box-border flex max-w-760px flex-col gap-28px pt-14px">
    <PageHeader :title="t('about.title')" :description="t('about.description')" />
    <OnAboutContent :content="config?.about ?? { sections, modules: [] }" :draft-label="t('about.draft')" />
  </div>
</template>
