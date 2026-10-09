<script setup lang="tsx">
import { reactive, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { fetchAuditLogs } from '@/service/api';
import type { QueryOf, RecordOf } from '@/typings/api/opennavo';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import AuditDiff from './audit-diff.vue';

defineOptions({ name: 'AuditLogTable' });

type Query = QueryOf<'listAuditLogs'>;
type Row = RecordOf<'listAuditLogs'>;

// Shared audit table for package history and system audit pages; click Changes for before/after diffs.
const props = withDefaults(
  defineProps<{ filters?: Omit<Query, 'current' | 'size'>; showEntity?: boolean }>(),
  { filters: () => ({}), showEntity: false }
);

const page = reactive({ current: 1, size: 20 });
const viewing = ref<Row | null>(null);

const { columns, data, loading, mobilePagination, getDataByPage } = useNaivePaginatedTable({
  api: () => fetchAuditLogs(compactParams({ ...props.filters, current: page.current, size: page.size }) as Query),
  transform: response => defaultTransform(response),
  paginationProps: { pageSizes: [20, 50, 100] },
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'createTime',
      title: $t('page.catalog.packageDetail.audit.columns.time'),
      width: 170,
      render: row => formatDateTime(row.createTime)
    },
    {
      key: 'actorName',
      title: $t('page.catalog.packageDetail.audit.columns.actor'),
      width: 140,
      render: row => row.actorName ?? $t('page.catalog.packageDetail.audit.system')
    },
    {
      key: 'action',
      title: $t('page.catalog.packageDetail.audit.columns.action'),
      minWidth: 200,
      render: row => <span class="font-mono text-12px">{row.action}</span>
    },
    ...(props.showEntity
      ? [
          {
            key: 'entity',
            title: $t('page.catalog.packageDetail.audit.columns.entity'),
            width: 180,
            render: (row: Row) => <span class="font-mono text-12px">{`${row.entityType}#${row.entityId}`}</span>
          }
        ]
      : []),
    {
      key: 'ip',
      title: $t('page.catalog.packageDetail.audit.columns.ip'),
      width: 140,
      render: row => <span class="font-mono text-12px">{row.ip ?? '—'}</span>
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 90,
      align: 'center',
      render: row =>
        row.before || row.after ? (
          <NButton size="small" quaternary type="primary" onClick={() => (viewing.value = row)}>
            {$t('page.catalog.packageDetail.audit.diff')}
          </NButton>
        ) : (
          '—'
        )
    }
  ]
});

watch(
  () => props.filters,
  () => void getDataByPage(1),
  { deep: true }
);
</script>

<template>
  <div>
    <NDataTable
      :columns="columns"
      :data="data"
      size="small"
      :loading="loading"
      remote
      :row-key="row => row.id"
      :pagination="mobilePagination"
      :scroll-x="900"
    />
    <NModal
      :show="Boolean(viewing)"
      preset="card"
      :title="viewing ? `${viewing.action} · ${viewing.entityType}#${viewing.entityId}` : ''"
      class="w-880px"
      @update:show="value => !value && (viewing = null)"
    >
      <AuditDiff v-if="viewing" :before="viewing.before" :after="viewing.after" />
    </NModal>
  </div>
</template>
