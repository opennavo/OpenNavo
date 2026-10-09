<script setup lang="tsx">
import { computed as computedFormattingLocale } from 'vue';
import { useAppStore as useFormattingAppStore } from '@/store/modules/app';
import { reactive, watch } from 'vue';
import { NButton } from 'naive-ui';
import { formatCount, formatPercent } from '@opennavo/shared';
import { fetchTopQueries, fetchZeroResultQueries } from '@/service/api';
import type { RecordOf } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { $t } from '@/locales';

const formattingAppStore = useFormattingAppStore();
const formattingLocale = computedFormattingLocale(() => formattingAppStore.locale);

defineOptions({ name: 'QueryTable' });

type Row = RecordOf<'listTopQueries'>;

// Shared popular/zero-result terms table; inline Add synonym for zero-result rows requires ops:search:edit.
const props = defineProps<{ mode: 'top' | 'zero'; days: number }>();
const emit = defineEmits<{ addSynonym: [query: string] }>();

const { hasAuth } = useAuth();
const page = reactive({ current: 1, size: 20 });

const { columns, data, loading, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    (props.mode === 'top' ? fetchTopQueries : fetchZeroResultQueries)({
      days: props.days,
      current: page.current,
      size: page.size
    }),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'query',
      title: $t('page.ops.search.columns.query'),
      minWidth: 200,
      render: (row: Row) => <span class="font-500">{row.query}</span>
    },
    {
      key: 'count',
      title: $t('page.ops.search.columns.count'),
      width: 100,
      align: 'right',
      render: (row: Row) => formatCount(row.count, { locale: formattingLocale.value })
    },
    {
      key: 'zeroResultCount',
      title: $t('page.ops.search.columns.zeroCount'),
      width: 110,
      align: 'right',
      render: (row: Row) => formatCount(row.zeroResultCount, { locale: formattingLocale.value })
    },
    ...(props.mode === 'top'
      ? [
          {
            key: 'clickCount',
            title: $t('page.ops.search.columns.clicks'),
            width: 90,
            align: 'right' as const,
            render: (row: Row) => formatCount(row.clickCount, { locale: formattingLocale.value })
          },
          {
            key: 'ctr',
            title: $t('page.ops.search.columns.ctr'),
            width: 90,
            align: 'right' as const,
            render: (row: Row) => (row.count ? formatPercent(row.clickCount / row.count, { locale: formattingLocale.value }) : '—')
          },
          {
            key: 'topClicked',
            title: $t('page.ops.search.columns.topClicked'),
            width: 180,
            render: (row: Row) => <span class="font-mono text-12px">{row.topClicked ?? '—'}</span>
          }
        ]
      : [
          {
            key: 'operate',
            title: $t('common.operate'),
            width: 130,
            align: 'center' as const,
            render: (row: Row) =>
              hasAuth('ops:search:edit') ? (
                <NButton size="small" quaternary type="primary" onClick={() => emit('addSynonym', row.query)}>
                  {$t('page.ops.search.addSynonym')}
                </NButton>
              ) : (
                '—'
              )
          }
        ])
  ]
});

watch(
  () => props.days,
  () => void getDataByPage(1)
);
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="data"
    size="small"
    :loading="loading"
    remote
    :row-key="row => row.query"
    :pagination="mobilePagination"
  />
</template>
