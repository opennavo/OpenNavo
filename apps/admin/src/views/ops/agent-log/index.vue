<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import CallsTab from './modules/calls-tab.vue';
import TranslationTab from './modules/translation-tab.vue';
import RevisionTab from './modules/revision-tab.vue';
import TrashTab from './modules/trash-tab.vue';

defineOptions({ name: 'OpsAgentLog' });

// Operations → Agent/AI logs (07 §10.4, 11 §4): Hermes calls, translations, revisions, recycle bin.
// Dashboard Hermes cards use ?tab= to open the corresponding tab.
// Avoid flex-height tables in NTabs without fixed panel heights, which collapse bodies to zero; use natural page scrolling, as audit logs do.
const TABS = ['calls', 'translations', 'revisions', 'trash'] as const;
type Tab = (typeof TABS)[number];

const route = useRoute();
const active = ref<Tab>('calls');
watch(
  () => route.query.tab,
  tab => {
    if (typeof tab === 'string' && (TABS as readonly string[]).includes(tab)) active.value = tab as Tab;
  },
  { immediate: true }
);
</script>

<template>
  <div class="flex-col-stretch gap-16px">
    <NCard :bordered="false" size="small" class="card-wrapper">
      <NTabs v-model:value="active" type="line" animated>
        <NTabPane name="calls" :tab="$t('page.ops.agentLog.tabs.calls')" display-directive="show:lazy">
          <CallsTab />
        </NTabPane>
        <NTabPane name="translations" :tab="$t('page.ops.agentLog.tabs.translations')" display-directive="show:lazy">
          <TranslationTab />
        </NTabPane>
        <NTabPane name="revisions" :tab="$t('page.ops.agentLog.tabs.revisions')" display-directive="show:lazy">
          <RevisionTab />
        </NTabPane>
        <NTabPane name="trash" :tab="$t('page.ops.agentLog.tabs.trash')" display-directive="show:lazy">
          <TrashTab />
        </NTabPane>
      </NTabs>
    </NCard>
  </div>
</template>
