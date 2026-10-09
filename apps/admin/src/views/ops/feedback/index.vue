<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NEllipsis, NTag, NText } from 'naive-ui';
import { fetchFeedbackList } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { useRouterPush } from '@/hooks/common/router';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import HandleForm from './modules/handle-form.vue';

defineOptions({ name: 'OpsFeedback' });

type Row = RecordOf<'listFeedback'>;

// Feedback (07 §7.11): filter by state/type, link packages to details, process in a dialog with status and notes.
const STATUS_TAG = { open: 'warning', in_progress: 'info', resolved: 'success', rejected: 'default' } as const;
const STATUSES = ['open', 'in_progress', 'resolved', 'rejected'] as const;
const TYPES = ['wrong_info', 'install_failed', 'broken_link', 'suggest_package', 'translation', 'other'] as const;

const appStore = useAppStore();
const { routerPushByKey } = useRouterPush();
const filters = reactive<{ status: Schemas['FeedbackStatus'] | null; type: Schemas['FeedbackType'] | null }>({
  status: 'open',
  type: null
});
const page = reactive({ current: 1, size: 20 });
const handling = ref<Row | null>(null);
const handleOpen = ref(false);

const statusOptions = computed(() => STATUSES.map(value => ({ value, label: $t(`page.ops.feedback.statuses.${value}`) })));
const typeOptions = computed(() => TYPES.map(value => ({ value, label: $t(`page.ops.feedback.types.${value}`) })));

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () => fetchFeedbackList(compactParams({ ...filters, current: page.current, size: page.size }) as QueryOf<'listFeedback'>),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'type',
      title: $t('page.ops.feedback.columns.type'),
      width: 110,
      render: row => (
        <NTag size="small" bordered={false}>
          {$t(`page.ops.feedback.types.${row.type}`)}
        </NTag>
      )
    },
    {
      key: 'package',
      title: $t('page.ops.feedback.columns.package'),
      width: 180,
      render: row =>
        row.packageId ? (
          <NButton
            text
            type="primary"
            onClick={() => routerPushByKey('catalog_package-detail', { params: { id: String(row.packageId) } })}
          >
            {row.packageName ?? row.packageToken ?? `#${row.packageId}`}
          </NButton>
        ) : (
          row.packageToken ?? '—'
        )
    },
    {
      key: 'content',
      title: $t('page.ops.feedback.columns.content'),
      minWidth: 260,
      render: row => <NEllipsis lineClamp={2}>{row.content}</NEllipsis>
    },
    {
      key: 'platform',
      title: $t('page.ops.feedback.columns.platform'),
      width: 150,
      render: row => (
        <div class="flex-col">
          <span>{row.platform === 'desktop' ? 'Desktop' : 'Web'}{row.appVersion ? ` ${row.appVersion}` : ''}</span>
          {row.osVersion && (
            <NText depth={3} class="text-12px">
              {row.osVersion}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'errorCode',
      title: $t('page.ops.feedback.columns.errorCode'),
      width: 120,
      render: row => <span class="font-mono text-12px">{row.errorCode ?? '—'}</span>
    },
    { key: 'contact', title: $t('page.ops.feedback.columns.contact'), width: 160, ellipsis: { tooltip: true }, render: row => row.contact ?? '—' },
    {
      key: 'status',
      title: $t('page.ops.feedback.columns.status'),
      width: 150,
      render: row => (
        <div class="flex-col gap-2px">
          <NTag size="small" bordered={false} type={STATUS_TAG[row.status]}>
            {$t(`page.ops.feedback.statuses.${row.status}`)}
          </NTag>
          {row.handledBy && (
            <NText depth={3} class="text-12px">
              {$t('page.ops.feedback.handled', { name: row.handledBy, time: formatDateTime(row.handledAt) })}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'createTime',
      title: $t('page.ops.feedback.columns.createTime'),
      width: 170,
      render: row => formatDateTime(row.createTime)
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 90,
      align: 'center',
      fixed: 'right',
      render: row => (
        <NButton
          size="small"
          type="primary"
          ghost
          onClick={() => {
            handling.value = row;
            handleOpen.value = true;
          }}
        >
          {$t('page.ops.feedback.handle')}
        </NButton>
      )
    }
  ]
});
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard :title="$t('page.ops.feedback.title')" :bordered="false" size="small" class="card-wrapper sm:flex-1-hidden">
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NSelect
            v-model:value="filters.status"
            :options="statusOptions"
            :placeholder="$t('page.ops.feedback.status')"
            clearable
            size="small"
            class="w-120px"
            @update:value="getDataByPage(1)"
          />
          <NSelect
            v-model:value="filters.type"
            :options="typeOptions"
            :placeholder="$t('page.ops.feedback.type')"
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
        :scroll-x="1500"
        :loading="loading"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
        class="sm:h-full"
      />
    </NCard>
    <HandleForm v-model:show="handleOpen" :feedback="handling" @saved="getData" />
  </div>
</template>
