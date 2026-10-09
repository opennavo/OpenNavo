<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { unwrap } from '@opennavo/api';
import { collectionIcons, OnCollectionsView, OnEmpty } from '@opennavo/ui';
import type { OnCollectionsItem } from '@opennavo/ui';
import RequestError from '@/components/common/RequestError.vue';
import { api } from '@/api';
import { useAppLocale } from '@/composables/useAppLocale';
import { useRemoteLoader } from '@/composables/useRemoteLoader';

// Collections (API, 06 §13: prompt to connect when offline); shared web view (ADR-017).
const { t } = useI18n();
const { appLocale } = useAppLocale();

const { data, error } = useRemoteLoader(
  'collections',
  () => unwrap(api.GET('/collections', { params: { query: { current: 1, size: 48 } } })),
  [appLocale]
);

const offline = computed(() => Boolean(error.value && !data.value));
const items = computed<OnCollectionsItem[] | null>(() => {
  if (offline.value) return [];
  return data.value
    ? data.value.records.map(collection => ({
        key: collection.slug,
        title: collection.title,
        subtitle: collection.subtitle,
        count: collection.itemCount,
        icons: collectionIcons(collection),
        href: `/collections/${collection.slug}`
      }))
    : null;
});
</script>

<template>
  <OnCollectionsView
    :title="t('collections.title')"
    :subtitle="t('collections.subtitle')"
    :items="items"
    :link-as="RouterLink"
  >
    <RequestError v-if="offline" :error="error" />
    <template #empty>
      <OnEmpty v-if="!offline" :title="t('collections.empty')" icon="lucide:library" />
    </template>
  </OnCollectionsView>
</template>
