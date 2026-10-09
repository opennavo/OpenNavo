<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NTag, NText } from 'naive-ui';
import { deleteFeature, fetchFeatureList } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { PUBLISH_STATUS_TAG, compactParams, formatDateTime } from '@/utils/opennavo';
import { pickLocalized } from '@/utils/content-locale';
import { $t } from '@/locales';
import FeatureForm from './modules/feature-form.vue';

defineOptions({ name: 'ContentFeature' });

type Row = RecordOf<'listFeatures'>;

// Features (07 §7.6): filter position/state, create/edit in dialogs with live preview, confirm deletion.
const appStore = useAppStore();
// Copy fallback: admin UI locale → source locale → English (04 §9.1).
const copyOf = (row: Row) => pickLocalized(row.i18n, appStore.locale, row.sourceLocale);
const filters = reactive<{ placement: Schemas['FeaturePlacement'] | null; status: Schemas['PublishStatus'] | null }>({
  placement: null,
  status: null
});
const page = reactive({ current: 1, size: 20 });
const formOpen = ref(false);
const editingId = ref<number | null>(null);

const placementOptions = computed(() =>
  (['home_hero', 'home_secondary', 'category_top'] as const).map(value => ({
    value,
    label: $t(`page.content.feature.placements.${value}`)
  }))
);
const statusOptions = computed(() =>
  (['draft', 'scheduled', 'published', 'archived'] as const).map(value => ({
    value,
    label: $t(`page.shared.publishStatus.${value}`)
  }))
);

function targetName(row: Row) {
  if (row.targetType === 'package') return row.packageName ?? `#${row.packageId}`;
  if (row.targetType === 'collection') return row.collectionTitle ?? `#${row.collectionId}`;
  return row.url ?? '—';
}

function open(id: number | null) {
  editingId.value = id;
  formOpen.value = true;
}

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () => fetchFeatureList(compactParams({ ...filters, current: page.current, size: page.size }) as QueryOf<'listFeatures'>),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'placement',
      title: $t('page.content.feature.columns.placement'),
      width: 120,
      render: row => $t(`page.content.feature.placements.${row.placement}`)
    },
    {
      key: 'title',
      title: $t('page.content.feature.columns.title'),
      minWidth: 200,
      render: row => (
        <div class="flex-col">
          <span class="font-600">{copyOf(row)?.title ?? '—'}</span>
          {copyOf(row)?.subtitle && (
            <NText depth={3} class="text-12px">
              {copyOf(row)?.subtitle}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'target',
      title: $t('page.content.feature.columns.target'),
      minWidth: 200,
      render: row => (
        <div class="flex items-center gap-8px">
          <NTag size="small" bordered={false}>
            {$t(`page.content.feature.targetTypes.${row.targetType}`)}
          </NTag>
          <span class="truncate">{targetName(row)}</span>
        </div>
      )
    },
    {
      key: 'range',
      title: $t('page.content.feature.columns.range'),
      width: 190,
      render: row => (
        <div class="flex-col text-12px">
          <span>{formatDateTime(row.startsAt)}</span>
          <span>{formatDateTime(row.endsAt)}</span>
        </div>
      )
    },
    {
      key: 'status',
      title: $t('page.content.feature.columns.status'),
      width: 96,
      render: row => (
        <NTag size="small" bordered={false} type={PUBLISH_STATUS_TAG[row.status]}>
          {$t(`page.shared.publishStatus.${row.status}`)}
        </NTag>
      )
    },
    { key: 'sort', title: $t('page.content.feature.columns.sort'), width: 72, align: 'right' },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 140,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex-center gap-8px">
          <NButton size="small" type="primary" ghost onClick={() => open(row.id)}>
            {$t('common.edit')}
          </NButton>
          <NButton size="small" type="error" quaternary onClick={() => remove(row)}>
            {$t('common.delete')}
          </NButton>
        </div>
      )
    }
  ]
});

function remove(row: Row) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.content.feature.deleteConfirm', { title: copyOf(row)?.title ?? '' }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteFeature(row.id);
      if (error) return;
      window.$message?.success($t('common.deleteSuccess'));
      await getData();
    }
  });
}
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard
      :title="$t('page.content.feature.title')"
      :bordered="false"
      size="small"
      class="card-wrapper sm:flex-1-hidden"
    >
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NSelect
            v-model:value="filters.placement"
            :options="placementOptions"
            :placeholder="$t('page.content.feature.placement')"
            clearable
            size="small"
            class="w-150px"
            @update:value="getDataByPage(1)"
          />
          <NSelect
            v-model:value="filters.status"
            :options="statusOptions"
            :placeholder="$t('page.content.feature.status')"
            clearable
            size="small"
            class="w-120px"
            @update:value="getDataByPage(1)"
          />
          <NButton size="small" type="primary" @click="open(null)">{{ $t('page.content.feature.create') }}</NButton>
          <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
        </div>
      </template>
      <NDataTable
        :columns="columns"
        :data="data"
        size="small"
        :flex-height="!appStore.isMobile"
        :scroll-x="1100"
        :loading="loading"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
        class="sm:h-full"
      />
    </NCard>
    <FeatureForm v-model:show="formOpen" :feature-id="editingId" @saved="getData" />
  </div>
</template>
