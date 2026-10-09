<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { fetchAdminUsers } from '@/service/api';
import type { QueryOf } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import AuditLogTable from '@/components/opennavo/audit-log-table.vue';
import { $t } from '@/locales';

defineOptions({ name: 'SystemAudit' });

type Filters = Omit<QueryOf<'listAuditLogs'>, 'current' | 'size'>;

// Audit logs (07 §7.14): filter actor, entity type, action, dates; click Changes for before/after diffs.
// User lists require system:user:edit; select actors by name with permission, otherwise enter an actor ID.
const ENTITY_TYPES = [
  'package',
  'category',
  'collection',
  'feature',
  'release',
  'synonym',
  'feedback',
  'desktop_release',
  'mirror',
  'app_config',
  'admin_user',
  'role'
];

const { hasAuth } = useAuth();
const canListUsers = hasAuth('system:user:edit');

const form = reactive<{
  actorId: number | null;
  entityType: string | null;
  action: string;
  range: [number, number] | null;
}>({
  actorId: null,
  entityType: null,
  action: '',
  range: null
});
const applied = ref<Filters>({});
const actors = ref<{ label: string; value: number }[]>([]);

if (canListUsers) {
  void fetchAdminUsers({ current: 1, size: 100 }).then(({ data, error }) => {
    if (!error)
      actors.value = data.records.map(user => ({ label: `${user.nickName}（${user.userName}）`, value: user.id }));
  });
}

const entityOptions = computed(() => ENTITY_TYPES.map(value => ({ label: value, value })));

function search() {
  applied.value = {
    actorId: form.actorId ?? undefined,
    entityType: form.entityType ?? undefined,
    action: form.action.trim() || undefined,
    from: form.range ? new Date(form.range[0]).toISOString() : undefined,
    to: form.range ? new Date(form.range[1]).toISOString() : undefined
  };
}

function reset() {
  Object.assign(form, { actorId: null, entityType: null, action: '', range: null });
  search();
}
</script>

<template>
  <div class="flex-col-stretch gap-16px">
    <NCard :bordered="false" size="small" class="card-wrapper">
      <NForm :model="form" label-placement="left" :label-width="80" :show-feedback="false">
        <NGrid responsive="screen" item-responsive :x-gap="16" :y-gap="12">
          <NFormItemGi
            span="24 s:12 m:6"
            :label="canListUsers ? $t('page.system.audit.actor') : $t('page.system.audit.actorId')"
          >
            <NSelect v-if="canListUsers" v-model:value="form.actorId" :options="actors" filterable clearable />
            <NInputNumber v-else v-model:value="form.actorId" :min="1" clearable class="w-full" />
          </NFormItemGi>
          <NFormItemGi span="24 s:12 m:6" :label="$t('page.system.audit.entityType')">
            <NSelect v-model:value="form.entityType" :options="entityOptions" filterable tag clearable />
          </NFormItemGi>
          <NFormItemGi span="24 s:12 m:6" :label="$t('page.system.audit.action')">
            <NInput
              v-model:value="form.action"
              :placeholder="$t('page.system.audit.actionPlaceholder')"
              clearable
              @keyup.enter="search"
            />
          </NFormItemGi>
          <NFormItemGi span="24 s:12 m:6" :label="$t('page.system.audit.range')">
            <NDatePicker v-model:value="form.range" type="datetimerange" clearable class="w-full" />
          </NFormItemGi>
          <NGi span="24" class="flex justify-end gap-12px">
            <NButton @click="reset">{{ $t('common.reset') }}</NButton>
            <NButton type="primary" ghost @click="search">{{ $t('common.search') }}</NButton>
          </NGi>
        </NGrid>
      </NForm>
    </NCard>
    <NCard :title="$t('page.system.audit.title')" :bordered="false" size="small" class="card-wrapper">
      <AuditLogTable :filters="applied" show-entity />
    </NCard>
  </div>
</template>
