<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { useIntervalFn } from '@vueuse/core';
import { NButton, NTag, NText } from 'naive-ui';
import { formatDuration } from '@opennavo/shared';
import { fetchJobRuns, fetchQueues, triggerJob } from '@/service/api';
import type { DataOf, QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import { JOB_TYPES, TRIGGER_TYPES, jobLabel } from './modules/job-labels';
import QueueCards from './modules/queue-cards.vue';

defineOptions({ name: 'OpsJob' });

type Row = RecordOf<'listJobRuns'>;

// Job center (07 §7.9): refresh queue every 10 seconds; manual triggers need ops:job:trigger plus confirmation; history below.
const appStore = useAppStore();
const STATUS_TAG = { running: 'info', succeeded: 'success', failed: 'error', partial: 'warning' } as const;
const STATUSES = ['running', 'succeeded', 'failed', 'partial'] as const;

const queues = ref<DataOf<'listQueues'>>([]);
async function loadQueues() {
  const { data, error } = await fetchQueues();
  if (!error) queues.value = data;
}
void loadQueues();
useIntervalFn(loadQueues, 10_000);

const filters = reactive<{ jobType: Schemas['JobType'] | null; status: string | null }>({ jobType: null, status: null });
const page = reactive({ current: 1, size: 20 });
const viewing = ref<Row | null>(null);

const typeOptions = computed(() => JOB_TYPES.map(value => ({ value, label: $t(`page.ops.job.types.${value}`) })));
const triggerOptions = computed(() =>
  TRIGGER_TYPES.map(value => ({ key: value, label: $t(`page.ops.job.types.${value}`) }))
);
const statusOptions = computed(() => STATUSES.map(value => ({ value, label: $t(`page.ops.job.statuses.${value}`) })));

function summary(stats: Record<string, unknown>) {
  return Object.entries(stats)
    .slice(0, 4)
    .map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchJobRuns(compactParams({ ...filters, current: page.current, size: page.size }) as QueryOf<'listJobRuns'>),
  transform: response => defaultTransform(response),
  paginationProps: { pageSizes: [20, 50, 100] },
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    { key: 'jobType', title: $t('page.ops.job.columns.type'), width: 170, render: row => jobLabel(row.jobType) },
    {
      key: 'trigger',
      title: $t('page.ops.job.columns.trigger'),
      width: 150,
      render: row => (
        <div class="flex-col">
          <span>{$t(`page.ops.job.triggers.${row.trigger}`)}</span>
          {row.triggeredBy && (
            <NText depth={3} class="text-12px">
              {row.triggeredBy}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'status',
      title: $t('page.ops.job.columns.status'),
      width: 100,
      render: row => (
        <NTag size="small" bordered={false} type={STATUS_TAG[row.status]}>
          {$t(`page.ops.job.statuses.${row.status}`)}
        </NTag>
      )
    },
    {
      key: 'startedAt',
      title: $t('page.ops.job.columns.startedAt'),
      width: 170,
      render: row => formatDateTime(row.startedAt)
    },
    {
      key: 'durationMs',
      title: $t('page.ops.job.columns.duration'),
      width: 110,
      render: row =>
        row.durationMs === null || row.durationMs === undefined
          ? '—'
          : formatDuration(row.durationMs / 1000, { locale: appStore.locale })
    },
    {
      key: 'stats',
      title: $t('page.ops.job.columns.stats'),
      minWidth: 240,
      ellipsis: { tooltip: true },
      render: row => <span class="font-mono text-12px">{summary(row.stats)}</span>
    },
    {
      key: 'error',
      title: $t('page.ops.job.columns.error'),
      minWidth: 200,
      ellipsis: { tooltip: true },
      render: row => (row.error ? <NText type="error">{row.error}</NText> : '—')
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 90,
      align: 'center',
      render: row => (
        <NButton size="small" quaternary type="primary" onClick={() => (viewing.value = row)}>
          {$t('page.ops.job.detail')}
        </NButton>
      )
    }
  ]
});

function trigger(type: Schemas['TriggerJobType']) {
  const job = $t(`page.ops.job.types.${type}`);
  window.$dialog?.warning({
    title: $t('page.ops.job.trigger'),
    content: $t('page.ops.job.triggerConfirm', { job }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await triggerJob(type);
      if (error) return;
      window.$message?.success($t('page.ops.job.triggered', { job }));
      await Promise.all([getData(), loadQueues()]);
    }
  });
}
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard :bordered="false" size="small" class="card-wrapper" :title="$t('page.ops.job.queues')">
      <template #header-extra>
        <div class="flex items-center gap-12px">
          <NText depth="3" class="text-12px">{{ $t('page.ops.job.autoRefresh') }}</NText>
          <PermissionGate code="ops:job:trigger">
            <NDropdown
              trigger="click"
              :options="triggerOptions"
              @select="trigger"
            >
              <NButton size="small" type="primary">{{ $t('page.ops.job.trigger') }}</NButton>
            </NDropdown>
          </PermissionGate>
        </div>
      </template>
      <QueueCards v-if="queues.length" :queues="queues" />
      <NEmpty v-else :description="$t('page.ops.job.queuesEmpty')" />
    </NCard>
    <NCard :title="$t('page.ops.job.runs')" :bordered="false" size="small" class="card-wrapper sm:flex-1-hidden">
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NSelect
            v-model:value="filters.jobType"
            :options="typeOptions"
            :placeholder="$t('page.ops.job.filters.type')"
            clearable
            size="small"
            class="w-180px"
            @update:value="getDataByPage(1)"
          />
          <NSelect
            v-model:value="filters.status"
            :options="statusOptions"
            :placeholder="$t('page.ops.job.filters.status')"
            clearable
            size="small"
            class="w-140px"
            @update:value="getDataByPage(1)"
          />
          <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
        </div>
      </template>
      <NDataTable
        :columns="columns"
        :data="data"
        size="small"
        :flex-height="!appStore.isMobile"
        :scroll-x="1300"
        :loading="loading"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
        class="sm:h-full"
      />
    </NCard>
    <NModal
      :show="Boolean(viewing)"
      preset="card"
      :title="viewing ? `${jobLabel(viewing.jobType)} · #${viewing.id}` : ''"
      class="w-720px"
      @update:show="value => !value && (viewing = null)"
    >
      <template v-if="viewing">
        <h4 class="m-0 mb-8px text-14px font-600">{{ $t('page.ops.job.stats') }}</h4>
        <pre
          class="m-0 max-h-360px overflow-auto text-12px leading-[1.6]"
        ><code>{{ JSON.stringify(viewing.stats, null, 2) }}</code></pre>
        <template v-if="viewing.error">
          <h4 class="m-0 mb-8px mt-16px text-14px font-600">{{ $t('page.ops.job.error') }}</h4>
          <NText type="error" tag="pre" class="m-0 whitespace-pre-wrap text-12px">{{ viewing.error }}</NText>
        </template>
      </template>
    </NModal>
  </div>
</template>
