<script setup lang="tsx">
import { computed, reactive, ref, watch } from 'vue';
import { NButton, NTag, NText, NTooltip } from 'naive-ui';
import { fetchAgentTokens, revokeAgentToken } from '@/service/api';
import type { DataOf, Schemas } from '@/typings/api/opennavo';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import { permissionLabel } from './permissions';
import type { AgentPermission } from './permissions';
import TokenForm from './token-form.vue';
import TokenCreated from './token-created.vue';

defineOptions({ name: 'AgentTokenDrawer' });

type Token = Schemas['AgentToken'];

// Client tokens: create (show plaintext once), edit permissions/expiry, revoke; lists display prefixes only.
const props = defineProps<{ client: Schemas['AgentClient'] | null; grantable: AgentPermission[]; mcpUrl: string }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ changed: [] }>();

const STATUS_TAG = { active: 'success', expired: 'warning', revoked: 'default' } as const;

const page = reactive({ current: 1, size: 20 });
const formOpen = ref(false);
const editing = ref<Token | null>(null);
const created = ref<DataOf<'createAgentToken'> | null>(null);
const createdOpen = ref(false);
const title = computed(() => (props.client ? $t('page.system.agent.tokensOf', { name: props.client.name }) : ''));

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  immediate: false,
  api: () => fetchAgentTokens(props.client?.id ?? 0, { current: page.current, size: page.size }),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'name',
      title: $t('page.system.agent.columns.tokenName'),
      minWidth: 160,
      render: row => (
        <div class="flex-col">
          <span>{row.name}</span>
          <NText depth={3} class="font-mono text-12px">
            {row.prefix}…
          </NText>
        </div>
      )
    },
    {
      key: 'status',
      title: $t('page.system.agent.columns.status'),
      width: 130,
      render: row => (
        <div class="flex flex-wrap items-center gap-4px">
          <NTag size="small" bordered={false} type={STATUS_TAG[row.status]}>
            {$t(`page.system.agent.tokenStatus.${row.status}`)}
          </NTag>
          {row.status === 'active' && row.expiringSoon && (
            <NTag size="small" bordered={false} type="warning">
              {$t('page.system.agent.expiringSoon')}
            </NTag>
          )}
        </div>
      )
    },
    {
      key: 'permissions',
      title: $t('page.system.agent.columns.permissions'),
      width: 110,
      render: row => (
        <NTooltip>
          {{
            trigger: () => <span>{`${row.permissions.length} / ${props.grantable.length}`}</span>,
            default: () => <div class="flex-col gap-2px">{row.permissions.map(code => <span key={code}>{permissionLabel(code)}</span>)}</div>
          }}
        </NTooltip>
      )
    },
    {
      key: 'allowDelete',
      title: $t('page.system.agent.columns.allowDelete'),
      width: 90,
      render: row => (row.allowDelete ? $t('page.shared.yes') : $t('page.shared.no'))
    },
    {
      key: 'expiresAt',
      title: $t('page.system.agent.columns.expiresAt'),
      width: 160,
      render: row => (row.expiresAt ? formatDateTime(row.expiresAt) : $t('page.system.agent.neverExpires'))
    },
    {
      key: 'lastUsed',
      title: $t('page.system.agent.columns.lastUsed'),
      width: 170,
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
      key: 'operate',
      title: $t('common.operate'),
      width: 200,
      align: 'center',
      fixed: 'right',
      render: row =>
        row.status === 'revoked' ? (
          '—'
        ) : (
          <div class="flex flex-wrap items-center justify-center gap-6px">
            <NButton size="small" onClick={() => openForm(row)}>
              {$t('common.edit')}
            </NButton>
            <NButton size="small" type="error" ghost onClick={() => revoke(row)}>
              {$t('page.system.agent.revoke')}
            </NButton>
          </div>
        )
    }
  ]
});

watch(show, open => {
  if (open && props.client) void getDataByPage(1);
});

function openForm(token: Token | null) {
  editing.value = token;
  formOpen.value = true;
}

function revoke(token: Token) {
  window.$dialog?.warning({
    title: $t('page.system.agent.revoke'),
    content: $t('page.system.agent.revokeConfirm', { name: token.name }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await revokeAgentToken(token.id);
      if (error) return;
      window.$message?.success($t('page.system.agent.revoked'));
      await getData();
      emit('changed');
    }
  });
}

async function onCreated(result: DataOf<'createAgentToken'>) {
  created.value = result;
  createdOpen.value = true;
  await getData();
  emit('changed');
}

function onCreatedClosed(open: boolean) {
  // Discard plaintext immediately after its one-time display closes; do not retain it in page state.
  if (!open) created.value = null;
}
</script>

<template>
  <NDrawer v-model:show="show" :width="1060" placement="right">
    <NDrawerContent :title="title" closable>
      <div class="flex-col gap-12px">
        <div class="flex items-center justify-between gap-12px">
          <NText depth="3" class="text-12px">{{ $t('page.system.agent.tokensHint') }}</NText>
          <NButton type="primary" size="small" :disabled="!client?.enabled" @click="openForm(null)">
            {{ $t('page.system.agent.addToken') }}
          </NButton>
        </div>
        <NDataTable
          :columns="columns"
          :data="data"
          :loading="loading"
          size="small"
          remote
          :scroll-x="960"
          :row-key="row => row.id"
          :pagination="mobilePagination"
        />
      </div>
    </NDrawerContent>
  </NDrawer>
  <TokenForm
    v-model:show="formOpen"
    :client-id="client?.id ?? null"
    :token="editing"
    :grantable="grantable"
    @saved="getData"
    @created="onCreated"
  />
  <TokenCreated
    v-model:show="createdOpen"
    :result="created"
    :mcp-url="mcpUrl"
    @update:show="onCreatedClosed"
  />
</template>
