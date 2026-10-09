<script setup lang="tsx">
import { computed, ref } from 'vue';
import { NButton, NEllipsis, NText } from 'naive-ui';
import { fetchAppConfig, updateAppConfig } from '@/service/api';
import type { DataOf } from '@/typings/api/opennavo';
import { formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import AboutEditor from './about-editor.vue';

defineOptions({ name: 'ReleaseConfig' });

type Item = DataOf<'listAppConfig'>[number];

// Remote configuration (07 §7.13): key/value table; validate arbitrary JSON including null before saving; show description/editor.
const items = ref<Item[]>([]);
const loading = ref(false);
const editing = ref<Item | null>(null);
const draft = ref('');
const description = ref('');
const saving = ref(false);

async function load() {
  loading.value = true;
  const { data, error } = await fetchAppConfig();
  if (!error) items.value = data;
  loading.value = false;
}
void load();

function open(item: Item) {
  editing.value = item;
  draft.value = JSON.stringify(item.value, null, 2);
  description.value = item.description ?? '';
}

const parsed = computed<{ ok: true; value: unknown } | { ok: false }>(() => {
  try {
    return { ok: true, value: JSON.parse(draft.value) as unknown };
  } catch {
    return { ok: false };
  }
});

const isAbout = computed(() => {
  if (editing.value?.key !== 'site.about' || !parsed.value.ok) return false;
  const value = parsed.value.value;
  if (!value || typeof value !== 'object' || !('locales' in value) || !('modules' in value)) return false;
  if (!Array.isArray(value.modules) || !value.locales || typeof value.locales !== 'object') return false;
  return Object.values(value.locales).every(sections => Array.isArray(sections) && sections.every(section =>
    section && typeof section.key === 'string' && typeof section.title === 'string' &&
    Array.isArray(section.paragraphs) && section.paragraphs.every((paragraph: unknown) => typeof paragraph === 'string') && typeof section.draft === 'boolean'
  ));
});

async function save() {
  const item = editing.value;
  const result = parsed.value;
  if (!item || !result.ok) return;
  saving.value = true;
  const { error } = await updateAppConfig(item.key, {
    value: result.value as Item['value'],
    description: description.value.trim() || null
  });
  saving.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  editing.value = null;
  await load();
}

const columns = [
  {
    key: 'key',
    title: $t('page.release.config.columns.key'),
    width: 280,
    render: (item: Item) => <span class="font-mono">{item.key}</span>
  },
  {
    key: 'value',
    title: $t('page.release.config.columns.value'),
    minWidth: 280,
    render: (item: Item) => (
      <NEllipsis class="font-mono text-12px" lineClamp={2}>
        {item.key === 'site.about' ? item.description : JSON.stringify(item.value)}
      </NEllipsis>
    )
  },
  {
    key: 'description',
    title: $t('page.release.config.columns.description'),
    minWidth: 200,
    render: (item: Item) => item.description ?? '—'
  },
  {
    key: 'updated',
    title: $t('page.release.config.columns.updated'),
    width: 180,
    render: (item: Item) => (
      <div class="flex-col">
        <span>{formatDateTime(item.updateTime)}</span>
        {item.updateBy && (
          <NText depth={3} class="text-12px">
            {item.updateBy}
          </NText>
        )}
      </div>
    )
  },
  {
    key: 'operate',
    title: $t('common.operate'),
    width: 90,
    align: 'center' as const,
    render: (item: Item) => (
      <NButton size="small" type="primary" ghost onClick={() => open(item)}>
        {$t('common.edit')}
      </NButton>
    )
  }
];
</script>

<template>
  <NCard :title="$t('page.release.config.title')" :bordered="false" size="small" class="card-wrapper">
    <template #header-extra>
      <NButton size="small" :loading="loading" @click="load">{{ $t('common.refresh') }}</NButton>
    </template>
    <NDataTable
      :columns="columns"
      :data="items"
      :loading="loading"
      size="small"
      :row-key="item => item.key"
      :scroll-x="980"
    />
    <NModal
      :show="Boolean(editing)"
      preset="card"
      :title="editing ? $t('page.release.config.editTitle', { key: editing.key }) : ''"
      class="w-680px"
      @update:show="value => !value && (editing = null)"
    >
      <NForm label-placement="top">
        <AboutEditor v-if="isAbout" v-model="draft" />
        <NCollapse v-if="editing?.key === 'site.about'">
          <NCollapseItem :title="$t('page.release.config.value')" name="json">
            <NInput v-model:value="draft" type="textarea" :rows="12" class="font-mono" />
          </NCollapseItem>
        </NCollapse>
        <NFormItem
          v-if="editing?.key !== 'site.about'"
          :label="$t('page.release.config.value')"
          :validation-status="parsed.ok ? undefined : 'error'"
          :feedback="parsed.ok ? undefined : $t('page.release.config.invalidJson')"
        >
          <NInput v-model:value="draft" type="textarea" :rows="12" class="font-mono" />
        </NFormItem>
        <NFormItem :label="$t('page.release.config.description')">
          <NInput v-model:value="description" clearable />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="flex justify-end gap-12px">
          <NButton @click="editing = null">{{ $t('common.cancel') }}</NButton>
          <NButton
            type="primary"
            :disabled="!parsed.ok || (editing?.key === 'site.about' && !isAbout)"
            :loading="saving"
            @click="save"
          >
            {{ $t('common.confirm') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </NCard>
</template>
