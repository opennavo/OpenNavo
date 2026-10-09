<script setup lang="tsx">
import { computed, reactive, ref } from 'vue';
import { NButton, NDropdown, NSwitch, NTag, NText } from 'naive-ui';
import { deleteAdminUser, fetchAdminUsers, forceLogoutAdminUser, updateAdminUser } from '@/service/api';
import type { QueryOf, RecordOf, Schemas } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { useAuthStore } from '@/store/modules/auth';
import { defaultTransform, useNaivePaginatedTable } from '@/hooks/common/table';
import { compactParams, formatDateTime } from '@/utils/opennavo';
import { $t } from '@/locales';
import PasswordForm from './modules/password-form.vue';
import UserForm from './modules/user-form.vue';

defineOptions({ name: 'SystemUser' });

type Row = RecordOf<'listAdminUsers'>;

// Administrators (07 §7.14): list, enable, create/edit, reset password, revoke sessions, delete; cannot delete/disable yourself.
const appStore = useAppStore();
const authStore = useAuthStore();
const filters = reactive<{ userName: string; status: Schemas['EnableStatus'] | null }>({ userName: '', status: null });
const page = reactive({ current: 1, size: 20 });
const formOpen = ref(false);
const passwordOpen = ref(false);
const editing = ref<Row | null>(null);

const isSelf = (row: Row) => String(row.id) === String(authStore.userInfo.userId);
const statusOptions = computed(() =>
  (['1', '2'] as const).map(value => ({ value, label: $t(`page.system.user.statusOptions.${value}`) }))
);

const { columns, data, loading, getData, getDataByPage, mobilePagination } = useNaivePaginatedTable({
  api: () => fetchAdminUsers(compactParams({ ...filters, current: page.current, size: page.size }) as QueryOf<'listAdminUsers'>),
  transform: response => defaultTransform(response),
  onPaginationParamsChange: params => {
    page.current = params.page ?? 1;
    page.size = params.pageSize ?? 20;
  },
  columns: () => [
    {
      key: 'userName',
      title: $t('page.system.user.userName'),
      minWidth: 160,
      render: row => (
        <div class="flex items-center gap-8px">
          <span class="font-600">{row.userName}</span>
          {isSelf(row) && (
            <NTag size="small" bordered={false} type="primary">
              {$t('page.system.user.self')}
            </NTag>
          )}
          {row.locked && (
            <NTag size="small" bordered={false} type="warning">
              {$t('page.system.user.locked')}
            </NTag>
          )}
        </div>
      )
    },
    { key: 'nickName', title: $t('page.system.user.nickName'), width: 140 },
    { key: 'email', title: $t('page.system.user.email'), width: 200, render: row => row.email ?? '—' },
    {
      key: 'roles',
      title: $t('page.system.user.roles'),
      width: 200,
      render: row => (
        <div class="flex flex-wrap gap-4px">
          {row.roles.map(role => (
            <NTag size="small" bordered={false}>
              {role}
            </NTag>
          ))}
        </div>
      )
    },
    {
      key: 'status',
      title: $t('page.system.user.status'),
      width: 90,
      render: row => (
        <NSwitch value={row.status === '1'} disabled={isSelf(row)} onUpdateValue={(value: boolean) => toggleStatus(row, value)} />
      )
    },
    {
      key: 'lastLoginAt',
      title: $t('page.system.user.lastLogin'),
      width: 190,
      render: row => (
        <div class="flex-col">
          <span>{formatDateTime(row.lastLoginAt)}</span>
          {row.lastLoginIp && (
            <NText depth={3} class="font-mono text-12px">
              {row.lastLoginIp}
            </NText>
          )}
        </div>
      )
    },
    {
      key: 'operate',
      title: $t('common.operate'),
      width: 150,
      align: 'center',
      fixed: 'right',
      render: row => (
        <div class="flex-center gap-8px">
          <NButton
            size="small"
            type="primary"
            ghost
            onClick={() => {
              editing.value = row;
              formOpen.value = true;
            }}
          >
            {$t('common.edit')}
          </NButton>
          <NDropdown
            trigger="click"
            options={[
              { key: 'password', label: $t('page.system.user.resetPassword') },
              { key: 'logout', label: $t('page.system.user.forceLogout'), disabled: isSelf(row) },
              { key: 'delete', label: $t('common.delete'), disabled: isSelf(row) }
            ]}
            onSelect={(key: string) => runMore(key, row)}
          >
            <NButton size="small">{$t('page.system.user.more')}</NButton>
          </NDropdown>
        </div>
      )
    }
  ]
});

async function toggleStatus(row: Row, enabled: boolean) {
  const { error } = await updateAdminUser(row.id, { status: enabled ? '1' : '2' });
  if (!error) await getData();
}

function confirm(content: string, action: () => Promise<{ error: unknown }>, success: string) {
  window.$dialog?.warning({
    title: $t('common.tip'),
    content,
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await action();
      if (error) return;
      window.$message?.success(success);
      await getData();
    }
  });
}

function runMore(key: string, row: Row) {
  editing.value = row;
  if (key === 'password') passwordOpen.value = true;
  if (key === 'logout')
    confirm(
      $t('page.system.user.forceLogoutConfirm', { name: row.userName }),
      () => forceLogoutAdminUser(row.id),
      $t('page.system.user.forceLogoutDone')
    );
  if (key === 'delete')
    confirm($t('page.system.user.deleteConfirm', { name: row.userName }), () => deleteAdminUser(row.id), $t('common.deleteSuccess'));
}

function create() {
  editing.value = null;
  formOpen.value = true;
}
</script>

<template>
  <div class="min-h-500px flex-col-stretch gap-16px overflow-hidden lt-sm:overflow-auto">
    <NCard :title="$t('page.system.user.title')" :bordered="false" size="small" class="card-wrapper sm:flex-1-hidden">
      <template #header-extra>
        <div class="flex items-center gap-8px">
          <NInput
            v-model:value="filters.userName"
            :placeholder="$t('page.system.user.userName')"
            clearable
            size="small"
            class="w-180px"
            @keyup.enter="getDataByPage(1)"
            @clear="getDataByPage(1)"
          />
          <NSelect
            v-model:value="filters.status"
            :options="statusOptions"
            :placeholder="$t('page.system.user.status')"
            clearable
            size="small"
            class="w-120px"
            @update:value="getDataByPage(1)"
          />
          <NButton size="small" type="primary" @click="create">{{ $t('page.system.user.addTitle') }}</NButton>
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
    <UserForm v-model:show="formOpen" :user="editing" @saved="getData" />
    <PasswordForm v-model:show="passwordOpen" :user="editing" />
  </div>
</template>
