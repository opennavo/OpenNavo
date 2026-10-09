<script setup lang="tsx">
import { computed, reactive } from 'vue';
import { NButton, NImage, NTag, NText } from 'naive-ui';
import { deleteCollection, fetchCollectionList, publishCollection, unpublishCollection } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { useAuth } from '@/hooks/business/auth';
import { useRouterPush } from '@/hooks/common/router';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { PUBLISH_STATUS_TAG, compactParams, formatDateTime } from '@/utils/opennavo';
import { pickLocalized } from '@/utils/content-locale';
import { $t } from '@/locales';

defineOptions({ name: 'ContentCollection' });

type Row = RecordOf<'listAdminCollections'>;

// Collections (07 §7.5): publish/unpublish requires content:collection:publish and confirmation; creation/editing opens details.
const appStore = useAppStore();
const { hasAuth } = useAuth();
const { routerPushByKey } = useRouterPush();
const filters = reactive<{ q: string; status: Schemas['PublishStatus'] | null }>({ q: '', status: null });
const page = reactive({ current: 1, size: 20 });

const statusOptions = computed(() =>
  (['draft', 'scheduled', 'published', 'archived'] as const).map(value => ({
    value,
    label: $t(`page.shared.publishStatus.${value}`)
  }))
);

// Text fallback: admin UI locale → source locale → English (04 §9.1).
const textOf = (row: Row) => pickLocalized(row.i18n, appStore.locale, row.sourceLocale);
const titleOf = (row: Row) => textOf(row)?.title ?? row.slug;
const openDetail = (id: number | 'new') =>
  routerPushByKey('content_collection-detail', { params: { id: String(id) } });

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchCollectionList(compactParams({ ...filters, q: filters.q.trim(), current: page.current, size: page.size }) as QueryOf<'listAdminCollections'>),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'cover',
      title: $t('page.content.collection.columns.cover'),
      width: 96,
      render: row =>
        row.coverUrl ? <NImage src={row.coverUrl} width={72} height={40} objectFit="cover" previewDisabled /> : '—'
    },
    {
      key: 'title',
      title: $t('page.content.collection.columns.title'),
      minWidth: 200,
      render: row => (
        <div class="flex-col">
          <span class="font-600">{titleOf(row)}</span>
          {textOf(row)?.subtitle && (
            <NText depth={3} class="text-12px">
              {textOf(row)?.subtitle}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'slug',
      title: $t('page.content.collection.columns.slug'),
      width: 150,
      render: row => <span class="font-mono text-12px">{row.slug}</span>
    },
    { key: 'itemCount', title: $t('page.content.collection.columns.items'), width: 72, align: 'right' },
    {
      key: 'status',
      title: $t('page.content.collection.columns.status'),
      width: 100,
      render: row => (
        <NTag size="small" bordered={false} type={PUBLISH_STATUS_TAG[row.status]}>
          {$t(`page.shared.publishStatus.${row.status}`)}
        </NTag>
      )
    },
    {
      key: 'publishAt',
      title: $t('page.content.collection.columns.publishAt'),
      width: 170,
      render: row => formatDateTime(row.publishAt)
    },
    { key: 'sort', title: $t('page.content.collection.columns.sort'), width: 72, align: 'right' },
    {
      key: 'updateTime',
      title: $t('page.content.collection.columns.updated'),
      width: 170,
      render: row => (
        <div class="flex-col">
          <span>{formatDateTime(row.updateTime)}</span>
          {row.updateBy && (
            <NText depth={3} class="text-12px">
              {row.updateBy}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 220,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex-center gap-8px">
          <NButton size="small" type="primary" ghost onClick={() => openDetail(row.id)}>
            {$t('common.edit')}
          </NButton>
          {hasAuth('content:collection:publish') &&
            (row.status === 'published' || row.status === 'scheduled' ? (
              <NButton size="small" onClick={() => togglePublish(row, false)}>
                {$t('page.content.collection.unpublish')}
              </NButton>
            ) : (
              <NButton size="small" onClick={() => togglePublish(row, true)}>
                {$t('page.content.collection.publish')}
              </NButton>
            ))}
          <NButton size="small" type="error" quaternary onClick={() => remove(row)}>
            {$t('common.delete')}
          </NButton>
        </div>
      )
    }
  ]
});

function togglePublish(row: Row, publish: boolean) {
  window.$dialog?.warning({
    title: publish ? $t('page.content.collection.publish') : $t('page.content.collection.unpublish'),
    content: publish
      ? $t('page.content.collection.publishConfirm', { title: titleOf(row) })
      : $t('page.content.collection.unpublishConfirm', { title: titleOf(row) }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = publish ? await publishCollection(row.id, { publishAt: null }) : await unpublishCollection(row.id);
      if (error) return;
      window.$message?.success(publish ? $t('page.content.collection.published') : $t('page.content.collection.unpublished'));
      await getData();
    }
  });
}

function remove(row: Row) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.content.collection.deleteConfirm', { title: titleOf(row) }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteCollection(row.id);
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
      :title="$t('page.content.collection.title')"
      :bordered="false"
      size="small"
      class="card-wrapper sm:flex-1-hidden"
    >
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NInput
            v-model:value="filters.q"
            :placeholder="$t('page.content.collection.keyword')"
            clearable
            size="small"
            class="w-200px"
            @keyup.enter="getDataByPage(1)"
            @clear="getDataByPage(1)"
          />
          <NSelect
            v-model:value="filters.status"
            :options="statusOptions"
            :placeholder="$t('page.content.collection.status')"
            clearable
            size="small"
            class="w-120px"
            @update:value="getDataByPage(1)"
          />
          <NButton size="small" type="primary" @click="openDetail('new')">
            {{ $t('page.content.collection.create') }}
          </NButton>
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
  </div>
</template>
