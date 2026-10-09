<script setup lang="tsx">
import { reactive, ref } from 'vue';
import { NButton, NSwitch, NTag, NText } from 'naive-ui';
import { deleteSynonym, fetchSynonyms, updateSynonym } from '@/service/api';
import type { RecordOf } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import QueryTable from './modules/query-table.vue';
import SynonymForm from './modules/synonym-form.vue';

defineOptions({ name: 'OpsSearch' });

type Synonym = RecordOf<'listSynonyms'>;

// Search insights (07 §7.10): popular/zero-result terms over 7/30/90 days and synonyms; edits require ops:search:edit.
const { hasAuth } = useAuth();
const editable = hasAuth('ops:search:edit');
const tab = ref<'top' | 'zero' | 'synonyms'>('top');
const days = ref(7);
const keyword = ref('');
const page = reactive({ current: 1, size: 20 });
const formOpen = ref(false);
const editing = ref<Synonym | null>(null);
const initialTerms = ref<string[]>([]);

function openForm(synonym: Synonym | null, terms: string[] = []) {
  editing.value = synonym;
  initialTerms.value = terms;
  formOpen.value = true;
}

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () => fetchSynonyms(compactParams({ q: keyword.value.trim(), current: page.current, size: page.size })),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'terms',
      title: $t('page.ops.search.columns.terms'),
      minWidth: 320,
      render: row => (
        <div class="flex flex-wrap gap-4px">
          {row.terms.map(term => (
            <NTag size="small" bordered={false}>
              {term}
            </NTag>
          ))}
        </div>
      )
    },
    {
      key: 'enabled',
      title: $t('page.ops.search.columns.enabled'),
      width: 80,
      render: row => (
        <NSwitch
          value={row.enabled}
          disabled={!editable}
          onUpdateValue={async (value: boolean) => {
            const { error } = await updateSynonym(row.id, { terms: row.terms, enabled: value });
            if (!error) await getData();
          }}
        />
      )
    },
    {
      key: 'updateTime',
      title: $t('page.ops.search.columns.updated'),
      width: 180,
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
      width: 140,
      align: 'center',
      render: row =>
        editable ? (
          <div class="flex-center gap-8px">
            <NButton size="small" type="primary" ghost onClick={() => openForm(row)}>
              {$t('common.edit')}
            </NButton>
            <NButton size="small" type="error" quaternary onClick={() => remove(row)}>
              {$t('common.delete')}
            </NButton>
          </div>
        ) : (
          '—'
        )
    }
  ]
});

function remove(row: Synonym) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.ops.search.deleteConfirm', { terms: row.terms.join(' / ') }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteSynonym(row.id);
      if (error) return;
      window.$message?.success($t('common.deleteSuccess'));
      await getData();
    }
  });
}

function addFromQuery(query: string) {
  openForm(null, [query]);
}
</script>

<template>
  <NCard :bordered="false" size="small" class="card-wrapper">
    <NTabs v-model:value="tab" type="line" animated>
      <template #suffix>
        <div class="flex items-center gap-8px">
          <NRadioGroup v-if="tab !== 'synonyms'" v-model:value="days" size="small">
            <NRadioButton v-for="value in [7, 30, 90]" :key="value" :value="value">
              {{ $t('page.ops.search.daysOption', { days: value }, { plural: value }) }}
            </NRadioButton>
          </NRadioGroup>
          <template v-else>
            <NInput
              v-model:value="keyword"
              size="small"
              clearable
              :placeholder="$t('page.ops.search.columns.terms')"
              class="w-180px"
              @keyup.enter="getDataByPage(1)"
              @clear="getDataByPage(1)"
            />
            <NButton v-if="editable" size="small" type="primary" @click="openForm(null)">
              {{ $t('page.ops.search.newSynonym') }}
            </NButton>
          </template>
        </div>
      </template>
      <NTabPane name="top" :tab="$t('page.ops.search.tabs.top')" display-directive="if">
        <QueryTable mode="top" :days="days" />
      </NTabPane>
      <NTabPane name="zero" :tab="$t('page.ops.search.tabs.zero')" display-directive="if">
        <QueryTable mode="zero" :days="days" @add-synonym="addFromQuery" />
      </NTabPane>
      <NTabPane name="synonyms" :tab="$t('page.ops.search.tabs.synonyms')">
        <NDataTable
          :columns="columns"
          :data="data"
          size="small"
          :loading="loading"
          remote
          :row-key="row => row.id"
          :pagination="mobilePagination"
        />
      </NTabPane>
    </NTabs>
    <SynonymForm
      v-model:show="formOpen"
      :synonym="editing"
      :initial-terms="initialTerms"
      @saved="((tab = 'synonyms'), getData())"
    />
  </NCard>
</template>
