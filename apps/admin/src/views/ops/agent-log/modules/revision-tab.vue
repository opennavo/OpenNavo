<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NTag, NText } from 'naive-ui';
import { fetchContentRevisions, restoreRevision } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import AuditDiff from '@/components/opennavo/audit-diff.vue';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import { actorLabel, entityOptions, historyRefLabel, rangeParams } from './shared';

defineOptions({ name: 'AgentRevisionTab' });

type Row = RecordOf<'listContentRevisions'>;

// Content revisions (latest 50 per object): side-by-side diffs; restoring triggers retranslation.
// Restoration also requires the original operation's permission, rechecked server-side; later-edit conflicts return 1003.
const ACTION_TAG = { create: 'success', update: 'info', delete: 'error', restore: 'warning', translate: 'default' } as const;
const { hasAuth } = useAuth();
const filters = reactive<{ entity: Schemas['HistoryEntity'] | null; objectKey: string | null; requestId: string | null; range: [number, number] | null }>({
  entity: null,
  objectKey: null,
  requestId: null,
  range: null
});
const page = reactive({ current: 1, size: 20 });
const viewing = ref<Row | null>(null);
const entities = computed(entityOptions);

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchContentRevisions(
      compactParams({
        entity: filters.entity,
        objectKey: filters.objectKey?.trim() || null,
        requestId: filters.requestId?.trim() || null,
        ...rangeParams(filters.range),
        current: page.current,
        size: page.size
      }) as QueryOf<'listContentRevisions'>
    ),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    { key: 'createdAt', title: $t('page.ops.agentLog.columns.time'), width: 170, render: row => formatDateTime(row.createdAt) },
    { key: 'object', title: $t('page.ops.agentLog.columns.object'), minWidth: 200, render: row => historyRefLabel(row.object) },
    { key: 'version', title: $t('page.ops.agentLog.columns.version'), width: 80, align: 'right', render: row => `v${row.version}` },
    { key: 'locale', title: $t('page.ops.agentLog.columns.locale'), width: 90, render: row => row.locale || '—' },
    {
      key: 'action',
      title: $t('page.ops.agentLog.columns.action'),
      width: 100,
      render: row => (
        <NTag size="small" bordered={false} type={ACTION_TAG[row.action]}>
          {$t(`page.ops.agentLog.actions.${row.action}`)}
        </NTag>
      )
    },
    { key: 'actor', title: $t('page.ops.agentLog.columns.actor'), width: 220, ellipsis: { tooltip: true }, render: row => actorLabel(row.actor) },
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
      width: 210,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex flex-wrap items-center justify-center gap-6px">
          <NButton size="small" onClick={() => (viewing.value = row)}>
            {$t('page.ops.agentLog.compare')}
          </NButton>
          {row.canRestore && hasAuth('content:revision:restore') && (
            <NButton size="small" type="warning" ghost onClick={() => restore(row)}>
              {$t('page.ops.agentLog.restore')}
            </NButton>
          )}
        </div>
      )
    }
  ]
});

function restore(row: Row) {
  window.$dialog?.warning({
    title: $t('page.ops.agentLog.restore'),
    content: $t('page.ops.agentLog.restoreRevisionConfirm', { object: historyRefLabel(row.object), version: row.version }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await restoreRevision(row.id, {});
      if (error) return;
      window.$message?.success($t('page.ops.agentLog.restored'));
      viewing.value = null;
      await getData();
    }
  });
}

defineExpose({ refresh: getData });
</script>

<template>
  <div class="flex-col gap-12px">
    <div class="flex flex-wrap items-center gap-8px">
      <NSelect v-model:value="filters.entity" :options="entities" :placeholder="$t('page.ops.agentLog.filters.entity')" clearable size="small" class="w-160px" @update:value="getDataByPage(1)" />
      <NInput v-model:value="filters.objectKey" :placeholder="$t('page.ops.agentLog.filters.objectKey')" clearable size="small" class="!w-180px" @change="getDataByPage(1)" />
      <NInput v-model:value="filters.requestId" :placeholder="$t('page.ops.agentLog.filters.requestId')" clearable size="small" class="!w-220px" @change="getDataByPage(1)" />
      <NDatePicker v-model:value="filters.range" type="daterange" clearable size="small" class="w-260px" @update:value="getDataByPage(1)" />
      <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
    </div>
    <NDataTable
      :columns="columns"
      :data="data"
      size="small"
      :scroll-x="1340"
      :loading="loading"
      remote
      :row-key="row => row.id"
      :pagination="mobilePagination"
    />
    <NDrawer :show="Boolean(viewing)" :width="760" @update:show="(open: boolean) => !open && (viewing = null)">
      <NDrawerContent v-if="viewing" :title="`${historyRefLabel(viewing.object)} · v${viewing.version}`" closable>
        <div class="flex-col gap-12px">
          <NText depth="3" class="text-12px">
            {{ $t(`page.ops.agentLog.actions.${viewing.action}`) }} · {{ actorLabel(viewing.actor) }} · {{ formatDateTime(viewing.createdAt) }}
          </NText>
          <AuditDiff :before="viewing.before" :after="viewing.after" />
          <div v-if="viewing.affectedUrls.length" class="flex-col gap-4px">
            <NText depth="3" class="text-12px">{{ $t('page.ops.agentLog.affectedUrls') }}</NText>
            <a v-for="url in viewing.affectedUrls" :key="url" :href="url" target="_blank" rel="noopener noreferrer" class="text-primary break-all">{{ url }}</a>
          </div>
        </div>
        <template v-if="viewing.canRestore && hasAuth('content:revision:restore')" #footer>
          <NButton type="warning" @click="restore(viewing)">{{ $t('page.ops.agentLog.restore') }}</NButton>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
