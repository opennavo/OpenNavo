<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { OnEmpty, OnSearchField, OnSearchResultsView } from '@opennavo/ui';
import type { OnSearchResult } from '@opennavo/ui';
import PackageGetButton from '@/components/package/PackageGetButton.vue';
import { commands, unwrap } from '@/ipc/client';
import { useAppLocale } from '@/composables/useAppLocale';
import { useCatalogLoader } from '@/composables/useCatalogLoader';

// Search (local FTS, 06 §7.1): Enter on View all results in the Command-K palette; truncate q to 64 characters, matching deep links. Cask-only (ADR-018).
// Shared with the web view (ADR-017).
const { t } = useI18n();
const { pick, appLocale } = useAppLocale();
const route = useRoute();
const router = useRouter();

const query = ref(String(route.query.q ?? '').slice(0, 64));

watch(
  () => route.query.q,
  value => {
    query.value = String(value ?? '').slice(0, 64);
  }
);
watch(query, value => void router.replace({ query: value ? { q: value } : {} }));

const { data, error } = useCatalogLoader(
  async () => {
    const q = query.value.trim();
    if (!q) return null;
    const result = await unwrap(
      commands.catalogSearch({
        q,
        kind: 'cask',
        category: null,
        includeDisabled: false,
        limit: 100,
        offset: 0
      })
    );
    return result;
  },
  [query, appLocale],
  result => result?.items.map(hit => hit.item) ?? []
);

const results = computed<OnSearchResult[] | null>(() =>
  !query.value.trim()
    ? []
    : data.value
      ? data.value.items.map(hit => ({
          key: `${hit.item.kind}/${hit.item.token}`,
          kind: hit.item.kind,
          token: hit.item.token,
          name: pick(hit.item.displayName, hit.item.name, hit.item.sourceLocale),
          src: hit.item.iconUrl,
          accent: hit.item.accentColor,
          meta: hit.item.token,
          description: pick(hit.item.summary, '', hit.item.sourceLocale) || null,
          matched: hit.matchedName ? t('search.alias', { name: hit.matchedName }) : null,
          href: `/package/cask/${hit.item.token}`
        }))
      : error.value
        ? []
        : null
);
const disabledOf = (token: string) => data.value?.items.find(hit => hit.item.token === token)?.item.disabled;
</script>

<template>
  <OnSearchResultsView
    :title="t('search.title')"
    :subtitle="data ? t('search.results', { q: query.trim(), count: data.total }, { plural: data.total }) : undefined"
    :results="results"
    :link-as="RouterLink"
  >
    <template #search>
      <OnSearchField v-model="query" :placeholder="t('search.prompt')" clearable />
    </template>
    <template #action="{ result }">
      <PackageGetButton :kind="result.kind" :token="result.token" :disabled="disabledOf(result.token)" />
    </template>
    <template #empty>
      <OnEmpty
        v-if="data"
        :title="t('search.empty', { q: query.trim() })"
        :description="t('search.emptyHint')"
        icon="lucide:search"
      />
      <OnEmpty v-else-if="!query.trim()" :title="t('search.prompt')" icon="lucide:search" />
    </template>
  </OnSearchResultsView>
</template>
