<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NTag, NText } from 'naive-ui';
import { fetchTrash, restoreTrash } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { booleanOptions, compactParams, formatDateTime, toBoolean } from '@/utils/opennavo';
import { $t } from '@/locales';
import { actorLabel, entityLabel, entityOptions, pretty, rangeParams } from './shared';

defineOptions({ name: 'AgentTrashTab' });

type Row = RecordOf<'listTrash'>;

// Recycle bin (30 days): deleted categories, collections, features, synonyms, terms, screenshots and translations; restoration preserves IDs/public URLs.
const { hasAuth } = useAuth();
const filters = reactive<{ entity: Schemas['HistoryEntity'] | null; restored: string | null; range: [number, number] | null }>({
  entity: null,
  restored: 'false',
  range: null
});
const page = reactive({ current: 1, size: 20 });
const viewing = ref<Row | null>(null);
const entities = computed(entityOptions);
const restoredOptions = computed(() => booleanOptions($t('page.ops.agentLog.restoredItems'), $t('page.ops.agentLog.notRestored')));

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchTrash(
      compactParams({
        entity: filters.entity,
        restored: toBoolean(filters.restored),
        ...rangeParams(filters.range),
        current: page.current,
        size: page.size
      }) as QueryOf<'listTrash'>
    ),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    { key: 'deletedAt', title: $t('page.ops.agentLog.columns.deletedAt'), width: 170, render: row => formatDateTime(row.deletedAt) },
    {
      key: 'label',
      title: $t('page.ops.agentLog.columns.object'),
      minWidth: 220,
      render: row => (
        <div class="flex-col">
          <span>{row.label}</span>
          <NText depth={3} class="text-12px">
            {`${entityLabel(row.object.entity)} · ${row.object.objectKey}`}
          </NText>
        </div>
      )
    },
    { key: 'actor', title: $t('page.ops.agentLog.columns.actor'), width: 220, ellipsis: { tooltip: true }, render: row => actorLabel(row.actor) },
    { key: 'expiresAt', title: $t('page.ops.agentLog.columns.expiresAt'), width: 170, render: row => formatDateTime(row.expiresAt) },
    {
      key: 'restoredAt',
      title: $t('page.ops.agentLog.columns.state'),
      width: 170,
      render: row =>
        row.restoredAt ? (
          <NTag size="small" bordered={false} type="success">
            {$t('page.ops.agentLog.restoredAt', { time: formatDateTime(row.restoredAt) })}
          </NTag>
        ) : (
          <NTag size="small" bordered={false}>
            {$t('page.ops.agentLog.inTrash')}
          </NTag>
        )
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
            {$t('page.ops.agentLog.view')}
          </NButton>
          {row.canRestore && !row.restoredAt && hasAuth('content:revision:restore') && (
            <NButton size="small" type="primary" ghost onClick={() => restore(row)}>
              {$t('page.ops.agentLog.restore')}
            </NButton>
          )}
        </div>
      )
    }
  ]
});

function restore(row: Row) {
  window.$dialog?.info({
    title: $t('page.ops.agentLog.restore'),
    content: $t('page.ops.agentLog.restoreTrashConfirm', { label: row.label }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await restoreTrash(row.id);
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
      <NSelect v-model:value="filters.restored" :options="restoredOptions" :placeholder="$t('page.ops.agentLog.filters.state')" clearable size="small" class="w-140px" @update:value="getDataByPage(1)" />
      <NDatePicker v-model:value="filters.range" type="daterange" clearable size="small" class="w-260px" @update:value="getDataByPage(1)" />
      <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
    </div>
    <NDataTable
      :columns="columns"
      :data="data"
      size="small"
      :scroll-x="1140"
      :loading="loading"
      remote
      :row-key="row => row.id"
      :pagination="mobilePagination"
    />
    <NDrawer :show="Boolean(viewing)" :width="640" @update:show="(open: boolean) => !open && (viewing = null)">
      <NDrawerContent v-if="viewing" :title="viewing.label" closable>
        <div class="flex-col gap-12px">
          <NText depth="3" class="text-12px">
            {{ $t('page.ops.agentLog.deletedBy', { actor: actorLabel(viewing.actor), time: formatDateTime(viewing.deletedAt) }) }}
          </NText>
          <pre class="m-0 max-h-480px overflow-auto rounded-small bg-layout p-12px text-12px"><code>{{ pretty(viewing.snapshot) }}</code></pre>
        </div>
        <template v-if="viewing.canRestore && !viewing.restoredAt && hasAuth('content:revision:restore')" #footer>
          <NButton type="primary" @click="restore(viewing)">{{ $t('page.ops.agentLog.restore') }}</NButton>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
