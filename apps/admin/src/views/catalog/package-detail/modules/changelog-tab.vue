<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NTag, NText, NTooltip } from 'naive-ui';
import { fetchChangelogSources, fetchPackageVersions, fetchPackageChangelogSettings, updatePackageChangelogSettings } from '@/service/api';
import type { DataOf, Schemas } from '@/typings/api/opennavo';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { formatDateTime } from '@/utils/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { $t } from '@/locales';

defineOptions({ name: 'ChangelogTab' });

const props = defineProps<{ packageId: number }>();

type Source = Schemas['ChangelogSource'];

// Persist scrape exclusions per package, independently of whether a source already exists.
const STATUS_TAG: Record<Source['lastStatus'], 'default' | 'success' | 'warning' | 'error'> = {
  never: 'default',
  ok: 'success',
  not_modified: 'default',
  error: 'error',
  rate_limited: 'warning',
  not_found: 'warning'
};

const { hasAuth } = useAuth();
const canEdit = computed(() => hasAuth('catalog:package:edit'));
const excluded = ref(false);
const settingsLoading = ref(true);
const settingsReady = ref(false);
const saving = ref(false);
async function loadSettings() {
  settingsLoading.value = true;
  settingsReady.value = false;
  try {
    const { data, error } = await fetchPackageChangelogSettings(props.packageId);
    if (!error && data) { excluded.value = data.excluded; settingsReady.value = true; }
  } finally { settingsLoading.value = false; }
}
async function toggleExcluded() {
  if (!settingsReady.value || saving.value || !canEdit.value) return;
  saving.value = true;
  try {
    const { data, error } = await updatePackageChangelogSettings(props.packageId, { excluded: !excluded.value });
    if (!error && data) { excluded.value = data.excluded; await loadSources(); }
  } finally { saving.value = false; }
}
void loadSettings();

const sources = ref<DataOf<'listChangelogSources'>>([]);
const sourcesLoading = ref(false);

async function loadSources() {
  sourcesLoading.value = true;
  const { data, error } = await fetchChangelogSources(props.packageId);
  if (!error) sources.value = data;
  sourcesLoading.value = false;
}
void loadSources();

const sourceColumns = [
  {
    key: 'type',
    title: $t('page.catalog.packageDetail.changelog.columns.type'),
    width: 150,
    render: (row: Source) => $t(`page.catalog.packageDetail.changelog.types.${row.type}`)
  },
  {
    key: 'config',
    title: $t('page.catalog.packageDetail.changelog.columns.config'),
    width: 320,
    ellipsis: { tooltip: true },
    render: (row: Source) => <span class="font-mono text-12px">{JSON.stringify(row.config)}</span>
  },
  {
    key: 'lastStatus',
    title: $t('page.catalog.packageDetail.changelog.columns.status'),
    width: 220,
    render: (row: Source) => {
      const tag = (
        <NTag size="small" bordered={false} type={STATUS_TAG[row.lastStatus]}>
          {$t(`page.catalog.packageDetail.changelog.status.${row.lastStatus}`)}
        </NTag>
      );
      return (
        <div class="flex-col items-start gap-2px">
          {row.lastError ? <NTooltip>{{ trigger: () => tag, default: () => row.lastError }}</NTooltip> : tag}
          <NText depth={3} class="text-12px">
            {formatDateTime(row.lastFetchedAt)}
            {row.failCount > 0 ? ` · ${$t('page.catalog.packageDetail.changelog.failCount', { count: row.failCount }, { plural: row.failCount })}` : ''}
          </NText>
        </div>
      );
    }
  },
  {
    key: 'nextFetchAt',
    title: $t('page.catalog.packageDetail.changelog.columns.nextFetch'),
    width: 170,
    render: (row: Source) => formatDateTime(row.nextFetchAt)
  }
];

const versionPage = reactive({ current: 1, size: 20 });
const {
  columns: versionColumns,
  data: versions,
  loading: versionsLoading,
  mobilePagination
} = useNaivePaginatedTable({
  api: () => fetchPackageVersions(props.packageId, { current: versionPage.current, size: versionPage.size }),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    versionPage.current = params.page ?? 1;
    versionPage.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'version',
      title: $t('page.catalog.packageDetail.changelog.versionColumns.version'),
      minWidth: 140,
      render: row => <span class="font-mono">{row.version}</span>
    },
    {
      key: 'firstSeenAt',
      title: $t('page.catalog.packageDetail.changelog.versionColumns.firstSeen'),
      width: 170,
      render: row => formatDateTime(row.firstSeenAt)
    },
    {
      key: 'brewCommittedAt',
      title: $t('page.catalog.packageDetail.changelog.versionColumns.committed'),
      width: 170,
      render: row => formatDateTime(row.brewCommittedAt)
    },
    {
      key: 'brewCommitSha',
      title: $t('page.catalog.packageDetail.changelog.versionColumns.commit'),
      width: 110,
      render: row => <span class="font-mono text-12px">{row.brewCommitSha?.slice(0, 7) ?? '—'}</span>
    },
    {
      key: 'releaseId',
      title: $t('page.catalog.packageDetail.changelog.versionColumns.release'),
      width: 100,
      render: row => (
        <NTag size="small" bordered={false} type={row.releaseId ? 'success' : 'default'}>
          {row.releaseId ? $t('page.catalog.packageDetail.changelog.linked') : $t('page.catalog.packageDetail.changelog.unlinked')}
        </NTag>
      )
    }
  ]
});
</script>

<template>
  <div class="flex-col gap-24px">
    <section class="flex-col gap-12px">
      <div class="flex flex-wrap items-center gap-12px">
        <NTag v-if="settingsReady" :type="excluded ? 'warning' : 'success'" :bordered="false">
          {{
            $t(
              excluded
                ? 'page.catalog.packageDetail.changelog.excluded'
                : 'page.catalog.packageDetail.changelog.fetchEnabled'
            )
          }}
        </NTag>
        <NPopconfirm v-if="canEdit && settingsReady" @positive-click="toggleExcluded">
          <template #trigger>
            <NButton :loading="saving" :disabled="saving || settingsLoading" size="small">
              {{
                $t(
                  excluded
                    ? 'page.catalog.packageDetail.changelog.resumeFetch'
                    : 'page.catalog.packageDetail.changelog.excludeFetch'
                )
              }}
            </NButton>
          </template>
          {{
            $t(
              excluded
                ? 'page.catalog.packageDetail.changelog.resumeConfirm'
                : 'page.catalog.packageDetail.changelog.excludeConfirm'
            )
          }}
        </NPopconfirm>
        <NButton v-if="!settingsReady" :loading="settingsLoading" size="small" @click="loadSettings">
          {{ $t('page.catalog.packageDetail.changelog.reloadSettings') }}
        </NButton>
      </div>
      <NText depth="3">{{ $t('page.catalog.packageDetail.changelog.exclusionHint') }}</NText>
      <div class="flex flex-wrap items-center gap-8px">
        <h3 class="m-0 text-15px font-600">{{ $t('page.catalog.packageDetail.changelog.sources') }}</h3>
        <NText depth="3" class="text-12px">{{ $t('page.catalog.packageDetail.changelog.sourcesHint') }}</NText>
      </div>
      <NDataTable
        :columns="sourceColumns"
        :data="sources"
        :loading="sourcesLoading"
        size="small"
        :row-key="row => row.id"
        :scroll-x="860"
      >
        <template #empty>
          <NEmpty :description="$t('page.catalog.packageDetail.changelog.noSources')" />
        </template>
      </NDataTable>
    </section>
    <section class="flex-col gap-12px">
      <h3 class="m-0 text-15px font-600">{{ $t('page.catalog.packageDetail.changelog.versions') }}</h3>
      <NDataTable
        :columns="versionColumns"
        :data="versions"
        :loading="versionsLoading"
        size="small"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
      />
    </section>
  </div>
</template>
