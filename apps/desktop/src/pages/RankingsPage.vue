<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { formatCountCompact } from '@opennavo/shared';
import { OnRankingsView, OnEmpty } from '@opennavo/ui';
import type { OnRankingsEntry } from '@opennavo/ui';
import PackageGetButton from '@/components/package/PackageGetButton.vue';
import { commands, unwrap } from '@/ipc/client';
import type { LocalItem } from '@/ipc/client';
import { useAppLocale } from '@/composables/useAppLocale';
import { useCatalogLoader } from '@/composables/useCatalogLoader';
import { usePackageSummary } from '@/composables/usePackageSummary';

// Rankings (local, offline): app installs over 30 / 90 / 365 days (Cask-only, ADR-018); show unavailable statistics for old snapshots missing 90/365-day data.
type Period = 'installs30d' | 'installs90d' | 'installs365d';

const { t } = useI18n();
const { appLocale } = useAppLocale();
const { toSummary } = usePackageSummary();

const period = ref<Period>('installs30d');

const { data, error } = useCatalogLoader(
  async () => {
    const result = await unwrap(
      commands.catalogList({
        kind: 'cask',
        category: null,
        sort: period.value,
        includeFonts: true,
        includeLibraries: false,
        includeDisabled: false,
        limit: 100,
        offset: 0
      })
    );
    return result.items;
  },
  [period, appLocale],
  items => items
);

function installs(item: LocalItem): number | null {
  if (period.value === 'installs30d') return item.installs30d;
  return (period.value === 'installs90d' ? item.installs90d : item.installs365d) ?? null;
}

const entries = computed<OnRankingsEntry[] | null>(() =>
  data.value
    ? data.value.map((item, index) => {
        const value = installs(item);
        const pkg = toSummary(item);
        return {
          rank: index + 1,
          pkg,
          value: value === null ? t('rankings.noStats') : formatCountCompact(value, { locale: appLocale.value }),
          href: `/package/cask/${pkg.token}`
        };
      })
    : error.value
      ? []
      : null
);

const periods = computed(() =>
  (['installs30d', 'installs90d', 'installs365d'] as const).map(value => ({
    value,
    label: t(`rankings.periods.${value}`)
  }))
);
</script>

<template>
  <OnRankingsView
    v-model:period="period"
    :title="t('rankings.title')"
    :subtitle="t('rankings.subtitle')"
    :periods="periods"
    :period-label="t('rankings.periodLabel')"
    :entries="entries"
    :link-as="RouterLink"
  >
    <template #empty><OnEmpty v-if="!error" :title="t('common.empty')" /></template>
    <template #action="{ entry }">
      <PackageGetButton :kind="entry.pkg.kind" :token="entry.pkg.token" :disabled="entry.pkg.disabled" />
    </template>
  </OnRankingsView>
</template>
