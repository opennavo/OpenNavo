<script setup lang="tsx">
import { ref } from 'vue';
import { NButton, NEllipsis, NSwitch, NTag, NText } from 'naive-ui';
import { deleteMirror, fetchMirrors, updateMirror } from '@/service/api';
import type { DataOf } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { DEFAULT_SOURCE_LOCALE, localeName, pickLocalized } from '@/utils/content-locale';
import { $t } from '@/locales';
import MirrorForm from './modules/mirror-form.vue';

defineOptions({ name: 'ReleaseMirror' });

type Mirror = DataOf<'listMirrors'>[number];

// Mirrors (07 §7.13): desktop source candidates/probe URLs; switches save immediately, create/edit/delete use dialogs and confirmation.
// Desktop always supplies official (key=official, first-launch-onboarding D2); it cannot be disabled/deleted here.
const OFFICIAL = 'official';
const appStore = useAppStore();
const mirrors = ref<Mirror[]>([]);

// Name fallback: admin UI locale → source locale → English (04 §9.1).
const nameOf = (mirror: Mirror) => pickLocalized(mirror.i18n, appStore.locale, mirror.sourceLocale)?.name ?? mirror.key;
const loading = ref(false);
const formOpen = ref(false);
const editing = ref<Mirror | null>(null);

async function load() {
  loading.value = true;
  const { data, error } = await fetchMirrors();
  if (!error) mirrors.value = [...data].sort((a, b) => a.sort - b.sort);
  loading.value = false;
}
void load();

function open(mirror: Mirror | null) {
  editing.value = mirror;
  formOpen.value = true;
}

async function toggle(mirror: Mirror, enabled: boolean) {
  const {
    id,
    createBy: _createBy,
    createTime: _createTime,
    updateBy: _updateBy,
    updateTime: _updateTime,
    i18n,
    sourceLocale,
    ...rest
  } = mirror;
  // Toggle-only writes include source text only, excluding read-only translation metadata (04 §9.1); preserve other translations.
  const source = sourceLocale ?? DEFAULT_SOURCE_LOCALE;
  const { error } = await updateMirror(id, {
    ...rest,
    enabled,
    sourceLocale: source,
    i18n: { [source]: { name: i18n[source]?.name ?? nameOf(mirror) } }
  });
  if (!error) await load();
}

function remove(mirror: Mirror) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.release.mirror.deleteConfirm', { name: nameOf(mirror) }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteMirror(mirror.id);
      if (error) return;
      window.$message?.success($t('common.deleteSuccess'));
      await load();
    }
  });
}

const host = (value: string | null | undefined) => (value ? value.replace(/^https:\/\//, '') : '—');

const columns = [
  {
    key: 'key',
    title: $t('page.release.mirror.columns.key'),
    width: 110,
    render: (row: Mirror) => <span class="font-mono">{row.key}</span>
  },
  {
    key: 'name',
    title: $t('page.release.mirror.columns.name'),
    width: 170,
    render: (row: Mirror) => (
      <div class="flex-col">
        <span class="font-600">{nameOf(row)}</span>
        <NText depth={3} class="text-12px">
          {row.key === OFFICIAL
            ? $t('page.release.mirror.officialRow')
            : row.sourceLocale
              ? localeName(row.sourceLocale)
              : ''}
        </NText>
      </div>
    )
  },
  {
    key: 'apiDomain',
    title: $t('page.release.mirror.columns.apiDomain'),
    minWidth: 220,
    render: (row: Mirror) => <NEllipsis class="font-mono text-12px">{host(row.apiDomain)}</NEllipsis>
  },
  {
    key: 'bottleDomain',
    title: $t('page.release.mirror.columns.bottleDomain'),
    minWidth: 220,
    render: (row: Mirror) => <NEllipsis class="font-mono text-12px">{host(row.bottleDomain)}</NEllipsis>
  },
  {
    key: 'probeUrl',
    title: $t('page.release.mirror.columns.probeUrl'),
    minWidth: 220,
    render: (row: Mirror) => <NEllipsis class="font-mono text-12px">{host(row.probeUrl)}</NEllipsis>
  },
  {
    key: 'recommended',
    title: $t('page.release.mirror.columns.recommended'),
    width: 80,
    render: (row: Mirror) =>
      row.recommended ? (
        <NTag size="small" bordered={false} type="success">
          {$t('page.shared.yes')}
        </NTag>
      ) : (
        '—'
      )
  },
  {
    key: 'enabled',
    title: $t('page.release.mirror.columns.enabled'),
    width: 80,
    render: (row: Mirror) => (
      <NSwitch
        value={row.enabled}
        disabled={row.key === OFFICIAL}
        onUpdateValue={(value: boolean) => toggle(row, value)}
      />
    )
  },
  { key: 'sort', title: $t('page.release.mirror.columns.sort'), width: 70, align: 'right' as const },
  {
    key: 'operate',
    title: $t('common.operate'),
    width: 140,
    align: 'center' as const,
    render: (row: Mirror) => (
      <div class="flex-center gap-8px">
        <NButton size="small" type="primary" ghost onClick={() => open(row)}>
          {$t('common.edit')}
        </NButton>
        <NButton size="small" type="error" quaternary disabled={row.key === OFFICIAL} onClick={() => remove(row)}>
          {$t('common.delete')}
        </NButton>
      </div>
    )
  }
];
</script>

<template>
  <NCard :title="$t('page.release.mirror.title')" :bordered="false" size="small" class="card-wrapper">
    <template #header-extra>
      <div class="flex gap-8px">
        <NButton size="small" type="primary" @click="open(null)">{{ $t('page.release.mirror.create') }}</NButton>
        <NButton size="small" :loading="loading" @click="load">{{ $t('common.refresh') }}</NButton>
      </div>
    </template>
    <NDataTable
      :columns="columns"
      :data="mirrors"
      :loading="loading"
      size="small"
      :row-key="row => row.id"
      :scroll-x="1250"
    />
    <MirrorForm v-model:show="formOpen" :mirror="editing" @saved="load" />
  </NCard>
</template>
