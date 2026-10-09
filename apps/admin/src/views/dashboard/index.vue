<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIntervalFn } from '@vueuse/core';
import dayjs from 'dayjs';
import { fetchDashboardOverview, fetchLlmUsage } from '@/service/api';
import type { DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';
import CoverageCard from './modules/coverage-card.vue';
import HermesCard from './modules/hermes-card.vue';
import LlmCard from './modules/llm-card.vue';
import StatCard from './modules/stat-card.vue';
import SyncCard from './modules/sync-card.vue';
import UsageChart from './modules/usage-chart.vue';

defineOptions({ name: 'Dashboard' });

// Dashboard (07 §7.1): scale, coverage, sync health, LLM usage, tasks; refresh every 60 seconds.
const overview = ref<DataOf<'getDashboardOverview'> | null>(null);
const usage = ref<DataOf<'getLlmUsage'>>([]);
const loading = ref(false);
const refreshedAt = ref<Date | null>(null);

async function load() {
  loading.value = true;
  const [summary, monthly] = await Promise.all([fetchDashboardOverview(), fetchLlmUsage({ months: 6 })]);
  if (!summary.error) overview.value = summary.data;
  if (!monthly.error) usage.value = monthly.data;
  refreshedAt.value = new Date();
  loading.value = false;
}

void load();
useIntervalFn(load, 60_000);

const stats = computed(() => {
  const packages = overview.value?.packages;
  if (!packages) return [];
  return [
    // App and font counts are disjoint and exclude disabled or removed packages.
    { key: 'total', label: $t('page.dashboard.total'), value: packages.casks },
    { key: 'fonts', label: $t('page.dashboard.fonts'), value: packages.fonts },
    {
      key: 'disabled',
      label: $t('page.dashboard.disabled'),
      value: packages.disabled,
      hint: $t('page.dashboard.disabledHint', { deprecated: packages.deprecated, hidden: packages.hidden })
    }
  ];
});
</script>

<template>
  <NSpin :show="loading && !overview">
    <div class="flex-col gap-16px">
      <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <NGi v-for="item in stats" :key="item.key" span="24 s:12 m:6">
          <StatCard :label="item.label" :value="item.value" :hint="item.hint" />
        </NGi>
        <NGi v-if="overview?.hermes" span="24 s:12 m:6">
          <HermesCard :hermes="overview.hermes" />
        </NGi>
      </NGrid>
      <template v-if="overview">
        <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
          <NGi span="24 m:16">
            <CoverageCard :coverage="overview.coverage" />
          </NGi>
          <NGi span="24 m:8">
            <SyncCard :jobs="overview.jobs" :snapshot="overview.snapshot" />
          </NGi>
          <NGi span="24 m:8">
            <LlmCard :llm="overview.llm" :feedback-open="overview.feedbackOpen" />
          </NGi>
          <NGi span="24 m:16">
            <UsageChart :usage="usage" />
          </NGi>
        </NGrid>
        <NText v-if="refreshedAt" depth="3" tag="p" class="m-0 text-right text-12px">
          {{ $t('page.dashboard.refreshedAt', { time: dayjs(refreshedAt).format('HH:mm:ss') }) }}
        </NText>
      </template>
    </div>
  </NSpin>
</template>
