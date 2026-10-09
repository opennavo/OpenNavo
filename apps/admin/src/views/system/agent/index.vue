<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { useClipboard } from '@vueuse/core';
import { NButton, NTag, NText } from 'naive-ui';
import { fetchAgentClients, fetchAgentSettings, updateAgentClient, updateAgentSettings } from '@/service/api';
import type { DataOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { useAuth } from '@/hooks/business/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import { hermesConfig } from './modules/permissions';
import ClientForm from './modules/client-form.vue';
import TokenDrawer from './modules/token-drawer.vue';

defineOptions({ name: 'SystemAgent' });

type Client = Schemas['AgentClient'];

// System → Agent access (07 §10.2, 11 §2.2): global switch (tokens invalid within 30 seconds of pause), limits, MCP URL/configuration,
// clients and tokens. Requires agent:manage (superadmin); Hermes can never access this area.
const appStore = useAppStore();
const { hasAuth } = useAuth();
const editable = computed(() => hasAuth('agent:manage'));
const { copy } = useClipboard({ legacy: true });

const settings = ref<DataOf<'getAgentSettings'> | null>(null);
const draft = reactive<Schemas['AgentSettingsUpdate']>({
  enabled: true,
  limits: { callsPerMinute: 120, writesPerDay: 3000, llmOpsPerDay: 1000, batchLimit: 100 }
});
const savingSettings = ref(false);
const config = computed(() => (settings.value ? hermesConfig(settings.value.mcpUrl) : ''));
const LIMIT_KEYS = ['callsPerMinute', 'writesPerDay', 'llmOpsPerDay', 'batchLimit'] as const;

async function loadSettings() {
  const { data, error } = await fetchAgentSettings();
  if (error) return;
  settings.value = data;
  draft.enabled = data.enabled;
  draft.limits = { ...data.limits };
}
void loadSettings();

async function saveSettings() {
  if (!draft.enabled && settings.value?.enabled) {
    const confirmed = await new Promise<boolean>(resolve => {
      window.$dialog?.warning({
        title: $t('page.system.agent.pauseTitle'),
        content: $t('page.system.agent.pauseConfirm'),
        positiveText: $t('common.confirm'),
        negativeText: $t('common.cancel'),
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onClose: () => resolve(false)
      });
    });
    if (!confirmed) return;
  }
  savingSettings.value = true;
  const { error } = await updateAgentSettings({ enabled: draft.enabled, limits: { ...draft.limits } });
  savingSettings.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  await loadSettings();
}

async function copyText(text: string) {
  await copy(text);
  window.$message?.success($t('page.system.agent.copied'));
}

const page = reactive({ current: 1, size: 20 });
const clientFormOpen = ref(false);
const editingClient = ref<Client | null>(null);
const drawerOpen = ref(false);
const drawerClient = ref<Client | null>(null);

const { columns, data, loading, getData, mobilePagination } = useNaivePaginatedTable({
  api: () => fetchAgentClients({ current: page.current, size: page.size }),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'name',
      title: $t('page.system.agent.columns.clientName'),
      minWidth: 180,
      render: row => (
        <div class="flex-col">
          <span class="font-600">{row.name}</span>
          {row.notes && (
            <NText depth={3} class="text-12px">
              {row.notes}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'enabled',
      title: $t('page.system.agent.columns.status'),
      width: 100,
      render: row => (
        <NTag size="small" bordered={false} type={row.enabled ? 'success' : 'default'}>
          {row.enabled ? $t('page.system.agent.clientEnabled') : $t('page.system.agent.clientDisabled')}
        </NTag>
      )
    },
    { key: 'activeTokenCount', title: $t('page.system.agent.columns.activeTokens'), width: 110, align: 'right' },
    {
      key: 'lastUsed',
      title: $t('page.system.agent.columns.lastUsed'),
      width: 180,
      render: row => (
        <div class="flex-col">
          <span>{formatDateTime(row.lastUsedAt)}</span>
          {row.lastUsedIp && (
            <NText depth={3} class="font-mono text-12px">
              {row.lastUsedIp}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'createdAt',
      title: $t('page.system.agent.columns.createdAt'),
      width: 170,
      render: row => formatDateTime(row.createdAt)
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 290,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex flex-wrap items-center justify-center gap-6px">
          <NButton size="small" type="primary" ghost onClick={() => openTokens(row)}>
            {$t('page.system.agent.tokens')}
          </NButton>
          {editable.value && (
            <NButton size="small" onClick={() => openClientForm(row)}>
              {$t('common.edit')}
            </NButton>
          )}
          {editable.value && (
            <NButton size="small" type={row.enabled ? 'warning' : 'default'} ghost onClick={() => toggleClient(row)}>
              {row.enabled ? $t('page.system.agent.disableClient') : $t('page.system.agent.enableClient')}
            </NButton>
          )}
        </div>
      )
    }
  ]
});

function openClientForm(client: Client | null) {
  editingClient.value = client;
  clientFormOpen.value = true;
}

function openTokens(client: Client) {
  drawerClient.value = client;
  drawerOpen.value = true;
}

function toggleClient(client: Client) {
  const enabled = !client.enabled;
  window.$dialog?.warning({
    title: enabled ? $t('page.system.agent.enableClient') : $t('page.system.agent.disableClient'),
    content: enabled
      ? $t('page.system.agent.enableClientConfirm', { name: client.name })
      : $t('page.system.agent.disableClientConfirm', { name: client.name }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await updateAgentClient(client.id, { enabled });
      if (error) return;
      window.$message?.success($t('page.shared.saved'));
      await getData();
    }
  });
}
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard :title="$t('page.system.agent.settingsTitle')" :bordered="false" size="small" class="card-wrapper">
      <NSpin :show="!settings">
        <NGrid :x-gap="24" :y-gap="16" responsive="screen" item-responsive>
          <NGi span="24 l:12">
            <NForm label-placement="left" :label-width="132" :disabled="!editable">
              <NFormItem :label="$t('page.system.agent.enabled')">
                <div class="flex items-center gap-12px">
                  <NSwitch v-model:value="draft.enabled" />
                  <NText depth="3" class="text-12px">{{ $t('page.system.agent.enabledHint') }}</NText>
                </div>
              </NFormItem>
              <NFormItem v-for="key in LIMIT_KEYS" :key="key" :label="$t(`page.system.agent.limits.${key}`)">
                <NInputNumber v-model:value="draft.limits[key]" :min="1" :precision="0" class="w-200px" />
              </NFormItem>
              <NText depth="3" class="block pl-132px text-12px lt-sm:pl-0">{{ $t('page.system.agent.limitsHint') }}</NText>
            </NForm>
            <PermissionGate code="agent:manage">
              <div class="mt-12px flex justify-end">
                <NButton type="primary" :loading="savingSettings" @click="saveSettings">
                  {{ $t('page.system.agent.saveSettings') }}
                </NButton>
              </div>
            </PermissionGate>
          </NGi>
          <NGi span="24 l:12">
            <div v-if="settings" class="flex-col gap-12px">
              <div class="flex-col gap-6px">
                <NText depth="3" class="text-12px">{{ $t('page.system.agent.mcpUrl') }}</NText>
                <div class="flex items-center gap-8px">
                  <NInput :value="settings.mcpUrl" readonly class="font-mono" />
                  <NButton @click="copyText(settings.mcpUrl)">{{ $t('page.system.agent.copy') }}</NButton>
                </div>
              </div>
              <div class="flex-col gap-6px">
                <div class="flex items-center justify-between">
                  <NText depth="3" class="text-12px">{{ $t('page.system.agent.configTitle') }}</NText>
                  <NButton size="small" quaternary @click="copyText(config)">{{ $t('page.system.agent.copy') }}</NButton>
                </div>
                <pre class="m-0 overflow-auto rounded-small bg-layout p-12px text-12px leading-[1.6]"><code>{{ config }}</code></pre>
                <NText depth="3" class="text-12px">{{ $t('page.system.agent.configHint') }}</NText>
              </div>
              <NText depth="3" class="text-12px">
                {{ $t('page.system.agent.updatedAt', { time: formatDateTime(settings.updatedAt) }) }}
              </NText>
            </div>
          </NGi>
        </NGrid>
      </NSpin>
    </NCard>
    <NCard :title="$t('page.system.agent.clientsTitle')" :bordered="false" size="small" class="card-wrapper sm:flex-1-hidden">
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NButton size="small" :loading="loading" @click="getData">{{ $t('common.refresh') }}</NButton>
          <PermissionGate code="agent:manage">
            <NButton size="small" type="primary" @click="openClientForm(null)">{{ $t('page.system.agent.addClient') }}</NButton>
          </PermissionGate>
        </div>
      </template>
      <NDataTable
        :columns="columns"
        :data="data"
        size="small"
        :flex-height="!appStore.isMobile"
        :scroll-x="1060"
        :loading="loading"
        remote
        :row-key="row => row.id"
        :pagination="mobilePagination"
        class="sm:h-full"
      />
    </NCard>
    <ClientForm v-model:show="clientFormOpen" :client="editingClient" @saved="getData" />
    <TokenDrawer
      v-model:show="drawerOpen"
      :client="drawerClient"
      :grantable="settings?.grantablePermissions ?? []"
      :mcp-url="settings?.mcpUrl ?? ''"
      @changed="getData"
    />
  </div>
</template>
