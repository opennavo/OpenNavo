<script setup lang="ts">
import { useAppLocale as useFormattingLocale } from '@/composables/useAppLocale';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { InstallStats } from '@opennavo/api';
import { formatCount, formatCountCompact } from '@opennavo/shared';
import { installTrend, monthlyInstalls, OnHBarChart } from '@opennavo/ui';
import { useAppLocale } from '@/composables/useAppLocale';

const { appLocale: formattingLocale } = useFormattingLocale();

// Monthly average installs (08 §11.7): compare averages from 30/90/365-day aggregates.
const props = defineProps<{ installs: InstallStats }>();

const { t } = useI18n();
const { appLocale } = useAppLocale();

const items = computed(() =>
  monthlyInstalls(props.installs).map(row => ({
    key: row.key,
    label: t(`package.monthly.${row.key}`),
    value: row.value,
    display: formatCountCompact(row.value, { locale: appLocale.value }),
    full: t(
      'package.monthly.full',
      { count: formatCount(row.value, { locale: formattingLocale.value }) },
      { plural: row.value }
    ),
    emphasis: row.key === 'd30'
  }))
);
</script>

<template>
  <section class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px pb-12px pt-14px">
    <h2 class="m-0 text-13px font-600 text-ink-primary">
      {{ t('package.monthly.title') }}
      <small class="mt-2px block text-11.5px font-400 text-ink-tertiary">{{
        t(`package.monthly.trend.${installTrend(installs)}`)
      }}</small>
    </h2>
    <OnHBarChart class="mt-12px" :caption="t('package.monthly.title')" :items="items" />
  </section>
</template>
