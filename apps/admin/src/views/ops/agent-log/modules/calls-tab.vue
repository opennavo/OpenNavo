<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NTag, NText } from 'naive-ui';
import { fetchAgentCalls, revertRequest } from '@/service/api';
import type { QueryOf, RecordOf } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { booleanOptions, compactParams, formatDateTime, isDryRun, toBoolean } from '@/utils/opennavo';
import { $t } from '@/locales';
import { historyRefLabel, pretty, rangeParams } from './shared';

defineOptions({ name: 'AgentCallsTab' });

type Row = RecordOf<'listAgentCalls'>;

// Hermes calls (180-day retention): sanitized argument summaries only; undo all changes from a call with content:revision:restore.
const { hasAuth } = useAuth();
const filters = reactive<{ tool: string | null; requestId: string | null; dryRun: string | null; range: [number, number] | null }>({
  tool: null,
  requestId: null,
  dryRun: null,
  range: null
});
const page = reactive({ current: 1, size: 20 });
const viewing = ref<Row | null>(null);
const dryRunOptions = computed(() => booleanOptions($t('page.ops.agentLog.dryRun'), $t('page.ops.agentLog.realCall')));

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchAgentCalls(
      compactParams({
        tool: filters.tool?.trim() || null,
        requestId: filters.requestId?.trim() || null,
        dryRun: toBoolean(filters.dryRun),
        ...rangeParams(filters.range),
        current: page.current,
        size: page.size
      }) as QueryOf<'listAgentCalls'>
    ),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    { key: 'createdAt', title: $t('page.ops.agentLog.columns.time'), width: 170, render: row => formatDateTime(row.createdAt) },
    {
      key: 'client',
      title: $t('page.ops.agentLog.columns.client'),
      width: 180,
      render: row => (
        <div class="flex-col">
          <span>{row.clientName}</span>
          <NText depth={3} class="font-mono text-12px">
            {row.tokenPrefix}…
          </NText>
        </div>
      )
    },
    {
      key: 'tool',
      title: $t('page.ops.agentLog.columns.tool'),
      width: 200,
      render: row => (
        <div class="flex-col">
          <span class="font-mono text-12px">{row.tool}</span>
          <NText depth={3} class="text-12px">
            {row.operationId}
          </NText>
        </div>
      )
    },
    {
      key: 'objects',
      title: $t('page.ops.agentLog.columns.objects'),
      minWidth: 200,
      render: row =>
        row.objects.length ? (
          <div class="flex flex-wrap gap-4px">
            {row.objects.slice(0, 3).map(item => (
              <NTag key={`${item.entity}:${item.objectKey}`} size="small" bordered={false}>
                {historyRefLabel(item)}
              </NTag>
            ))}
            {row.objects.length > 3 && <NText depth={3}>+{row.objects.length - 3}</NText>}
          </div>
        ) : (
          '—'
        )
    },
    {
      key: 'code',
      title: $t('page.ops.agentLog.columns.result'),
      width: 120,
      render: row => (
        <div class="flex flex-wrap items-center gap-4px">
          <NTag size="small" bordered={false} type={row.code === '0000' ? 'success' : 'error'}>
            {row.code === '0000' ? $t('page.ops.agentLog.succeeded') : row.code}
          </NTag>
          {row.dryRun && (
            <NTag size="small" bordered={false} type="info">
              {$t('page.ops.agentLog.dryRun')}
            </NTag>
          )}
        </div>
      )
    },
    { key: 'durationMs', title: $t('page.ops.agentLog.columns.duration'), width: 90, align: 'right', render: row => `${row.durationMs} ms` },
    {
      key: 'requestId',
      title: $t('page.ops.agentLog.columns.requestId'),
      width: 180,
      ellipsis: { tooltip: true },
      render: row => <span class="font-mono text-12px">{row.requestId}</span>
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 200,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex flex-wrap items-center justify-center gap-6px">
          <NButton size="small" onClick={() => (viewing.value = row)}>
            {$t('page.ops.agentLog.detail')}
          </NButton>
          {row.canRevert && !row.revertedByRequestId && hasAuth('content:revision:restore') && (
            <NButton size="small" type="warning" ghost onClick={() => revert(row)}>
              {$t('page.ops.agentLog.revert')}
            </NButton>
          )}
        </div>
      )
    }
  ]
});

function revert(row: Row) {
  window.$dialog?.warning({
    title: $t('page.ops.agentLog.revert'),
    content: $t('page.ops.agentLog.revertConfirm', { tool: row.tool, requestId: row.requestId }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { data: result, error } = await revertRequest(row.requestId);
      if (error || isDryRun(result)) return;
      window.$message?.success($t('page.ops.agentLog.reverted', { count: result.restored.length }));
      await getData();
    }
  });
}

defineExpose({ refresh: getData });
</script>

<template>
  <div class="flex-col gap-12px">
    <div class="flex flex-wrap items-center gap-8px">
      <NInput v-model:value="filters.tool" :placeholder="$t('page.ops.agentLog.filters.tool')" clearable size="small" class="!w-180px" @change="getDataByPage(1)" />
      <NInput v-model:value="filters.requestId" :placeholder="$t('page.ops.agentLog.filters.requestId')" clearable size="small" class="!w-220px" @change="getDataByPage(1)" />
      <NSelect v-model:value="filters.dryRun" :options="dryRunOptions" :placeholder="$t('page.ops.agentLog.filters.dryRun')" clearable size="small" class="w-140px" @update:value="getDataByPage(1)" />
      <NDatePicker v-model:value="filters.range" type="daterange" clearable size="small" class="w-260px" @update:value="getDataByPage(1)" />
      <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
    </div>
    <NDataTable
      :columns="columns"
      :data="data"
      size="small"
      :scroll-x="1450"
      :loading="loading"
      remote
      :row-key="row => row.id"
      :pagination="mobilePagination"
    />
    <NDrawer :show="Boolean(viewing)" :width="640" @update:show="(open: boolean) => !open && (viewing = null)">
      <NDrawerContent v-if="viewing" :title="viewing.tool" closable>
        <div class="flex-col gap-12px">
          <NDescriptions :column="1" label-placement="left" bordered size="small" label-class="w-120px whitespace-nowrap">
            <NDescriptionsItem :label="$t('page.ops.agentLog.columns.time')">{{ formatDateTime(viewing.createdAt) }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('page.ops.agentLog.columns.client')">{{ viewing.clientName }} · {{ viewing.tokenPrefix }}…</NDescriptionsItem>
            <NDescriptionsItem :label="$t('page.ops.agentLog.operationId')">{{ viewing.operationId }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('page.ops.agentLog.columns.result')">
              {{ viewing.code === '0000' ? $t('page.ops.agentLog.succeeded') : viewing.code }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="$t('page.ops.agentLog.columns.requestId')">
              <span class="font-mono text-12px">{{ viewing.requestId }}</span>
            </NDescriptionsItem>
            <NDescriptionsItem v-if="viewing.revertedByRequestId" :label="$t('page.ops.agentLog.revertedBy')">
              <span class="font-mono text-12px">{{ viewing.revertedByRequestId }}</span>
            </NDescriptionsItem>
          </NDescriptions>
          <div class="flex-col gap-6px">
            <NText depth="3" class="text-12px">{{ $t('page.ops.agentLog.paramsSummary') }}</NText>
            <pre class="m-0 max-h-260px overflow-auto rounded-small bg-layout p-12px text-12px"><code>{{ pretty(viewing.paramsSummary) }}</code></pre>
          </div>
          <div class="flex-col gap-6px">
            <NText depth="3" class="text-12px">{{ $t('page.ops.agentLog.resultSummary') }}</NText>
            <pre class="m-0 max-h-260px overflow-auto rounded-small bg-layout p-12px text-12px"><code>{{ pretty(viewing.resultSummary) }}</code></pre>
          </div>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
