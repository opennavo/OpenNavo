<script setup lang="tsx">
import { computed as computedFormattingLocale } from 'vue';
import { useAppStore as useFormattingAppStore } from '@/store/modules/app';
import { computed, reactive, ref } from 'vue';
import { NButton, NDropdown, NTag, NText } from 'naive-ui';
import { formatBytes } from '@opennavo/shared';
import { fetchDesktopReleases, publishDesktopRelease, rollbackDesktopRelease } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import NotesForm from './modules/notes-form.vue';

const formattingAppStore = useFormattingAppStore();
const formattingLocale = computedFormattingLocale(() => formattingAppStore.locale);

defineOptions({ name: 'ReleaseDesktop' });

type Row = RecordOf<'listDesktopReleases'>;
type Channel = Schemas['ReleaseChannel'];

// Desktop releases (07 §7.12): CI registers drafts; UI cannot create them. Editing notes requires release:desktop:edit.
// Publishing (replaces desktop/{channel}/latest.json) and rollback require release:desktop:publish plus confirmation.
const STATUS_TAG = { draft: 'default', published: 'success', rolled_back: 'warning' } as const;
const APP_TARGETS = ['darwin-aarch64', 'darwin-x86_64'];

const appStore = useAppStore();
const { hasAuth } = useAuth();
const filters = reactive<{ channel: Channel | null }>({ channel: null });
const page = reactive({ current: 1, size: 20 });
const notesOpen = ref(false);
const editing = ref<Row | null>(null);

const channelOptions = computed(() =>
  (['stable', 'beta'] as const).map(value => ({ value, label: $t(`page.release.desktop.channels.${value}`) }))
);

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () =>
    fetchDesktopReleases(compactParams({ ...filters, current: page.current, size: page.size }) as QueryOf<'listDesktopReleases'>),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'version',
      title: $t('page.release.desktop.columns.version'),
      width: 130,
      render: row => <span class="font-mono font-600">{row.version}</span>
    },
    {
      key: 'channel',
      title: $t('page.release.desktop.columns.channel'),
      width: 80,
      render: row => (
        <NTag size="small" bordered={false} type={row.channel === 'beta' ? 'info' : 'default'}>
          {$t(`page.release.desktop.channels.${row.channel}`)}
        </NTag>
      )
    },
    {
      key: 'status',
      title: $t('page.release.desktop.columns.status'),
      width: 90,
      render: row => (
        <NTag size="small" bordered={false} type={STATUS_TAG[row.status]}>
          {$t(`page.release.desktop.statuses.${row.status}`)}
        </NTag>
      )
    },
    { key: 'minMacos', title: $t('page.release.desktop.columns.minMacos'), width: 90 },
    {
      key: 'artifacts',
      title: $t('page.release.desktop.columns.artifacts'),
      minWidth: 300,
      render: row => (
        <div class="flex flex-wrap gap-6px">
          {row.artifacts.map(artifact => (
            <NTag
              size="small"
              bordered={false}
              type={APP_TARGETS.includes(artifact.target) && !artifact.signature ? 'warning' : 'default'}
            >
              {`${$t(`page.release.desktop.targets.${artifact.target}`)} · ${formatBytes(artifact.bytes, { locale: formattingLocale.value })}`}
              {APP_TARGETS.includes(artifact.target) && !artifact.signature ? ` · ${$t('page.release.desktop.unsigned')}` : ''}
            </NTag>
          ))}
        </div>
      )
    },
    {
      key: 'published',
      title: $t('page.release.desktop.columns.published'),
      width: 180,
      render: row => (
        <div class="flex-col">
          <span>{formatDateTime(row.pubDate)}</span>
          {row.publishedBy && (
            <NText depth={3} class="text-12px">
              {row.publishedBy}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'createTime',
      title: $t('page.release.desktop.columns.createTime'),
      width: 170,
      render: row => formatDateTime(row.createTime)
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 190,
      align: 'center',
      fixed: 'right',
      render: row => {
        const options = hasAuth('release:desktop:publish')
          ? [
              ...(row.status !== 'published' ? [{ key: 'publish', label: $t('page.release.desktop.publish') }] : []),
              ...(isCurrent(row) ? [{ key: 'rollback', label: $t('page.release.desktop.rollback') }] : [])
            ]
          : [];
        return (
          <div class="flex-center gap-8px">
            {hasAuth('release:desktop:edit') && (
              <NButton
                size="small"
                type="primary"
                ghost
                onClick={() => {
                  editing.value = row;
                  notesOpen.value = true;
                }}
              >
                {$t('page.release.desktop.editNotes')}
              </NButton>
            )}
            {options.length > 0 && (
              <NDropdown trigger="click" options={options} onSelect={(key: string) => act(key, row)}>
                <NButton size="small">{$t('page.release.desktop.more')}</NButton>
              </NDropdown>
            )}
          </div>
        );
      }
    }
  ]
});

// Rollback accepts only the channel's current published version (03 §13.3), the latest publication in that channel.
function isCurrent(row: Row) {
  if (row.status !== 'published') return false;
  return !data.value.some(
    other =>
      other.channel === row.channel && other.status === 'published' && (other.pubDate ?? '') > (row.pubDate ?? '')
  );
}

function act(key: string, row: Row) {
  const channel = $t(`page.release.desktop.channels.${row.channel}`);
  const publish = key === 'publish';
  window.$dialog?.warning({
    title: publish ? $t('page.release.desktop.publish') : $t('page.release.desktop.rollback'),
    content: publish
      ? $t('page.release.desktop.publishConfirm', { version: row.version, channel, channelKey: row.channel })
      : $t('page.release.desktop.rollbackConfirm', { version: row.version, channel }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = publish ? await publishDesktopRelease(row.id) : await rollbackDesktopRelease(row.id);
      if (error) return;
      window.$message?.success(publish ? $t('page.release.desktop.publishDone') : $t('page.release.desktop.rollbackDone'));
      await getData();
    }
  });
}
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard
      :title="$t('page.release.desktop.title')"
      :bordered="false"
      size="small"
      class="card-wrapper sm:flex-1-hidden"
    >
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NText depth="3" class="text-12px">{{ $t('page.release.desktop.draftHint') }}</NText>
          <NSelect
            v-model:value="filters.channel"
            :options="channelOptions"
            :placeholder="$t('page.release.desktop.channel')"
            clearable
            size="small"
            class="w-110px"
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
        :scroll-x="1250"
        :loading="loading"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
        class="sm:h-full"
      />
    </NCard>
    <NotesForm v-model:show="notesOpen" :release="editing" @saved="getData" />
  </div>
</template>
