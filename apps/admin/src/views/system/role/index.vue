<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { deleteRole, fetchPermissions, fetchRoles, setRolePermissions } from '@/service/api';
import type { DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';
import RoleForm from './modules/role-form.vue';

defineOptions({ name: 'SystemRole' });

type Role = DataOf<'listRoles'>[number];
type Permission = DataOf<'listPermissions'>[number];

// Roles/permissions (07 §7.14): roles left, grouped permissions right; superadmin has all permissions, built-in roles cannot be deleted.
const SUPER = import.meta.env.VITE_STATIC_SUPER_ROLE || 'R_SUPER';
const GROUP_ORDER = ['dashboard', 'catalog', 'content', 'changelog', 'translation', 'ops', 'release', 'system'];

const roles = ref<Role[]>([]);
const permissions = ref<Permission[]>([]);
const selectedId = ref<number | null>(null);
const checked = ref<string[]>([]);
const loading = ref(false);
const saving = ref(false);
const formOpen = ref(false);
const editing = ref<Role | null>(null);

const selected = computed(() => roles.value.find(role => role.id === selectedId.value) ?? null);
const isSuper = computed(() => selected.value?.roleCode === SUPER);
const dirty = computed(
  () => selected.value && [...checked.value].sort().join() !== [...selected.value.permissionCodes].sort().join()
);

const groups = computed(() => {
  const map = new Map<string, Permission[]>();
  for (const permission of permissions.value)
    map.set(permission.group, [...(map.get(permission.group) ?? []), permission]);
  return [...map.entries()].sort(([a], [b]) => {
    const order = (group: string) => (GROUP_ORDER.includes(group) ? GROUP_ORDER.indexOf(group) : GROUP_ORDER.length);
    return order(a) - order(b);
  });
});

const groupLabel = (group: string) =>
  GROUP_ORDER.includes(group) ? $t(`page.system.role.groups.${group as 'catalog'}`) : group;

async function load(keep?: number) {
  loading.value = true;
  const [roleResult, permissionResult] = await Promise.all([fetchRoles(), fetchPermissions()]);
  if (!roleResult.error) roles.value = roleResult.data;
  if (!permissionResult.error) permissions.value = permissionResult.data;
  loading.value = false;
  selectedId.value = keep ?? selectedId.value ?? roles.value.find(role => role.roleCode !== SUPER)?.id ?? null;
}
void load();

watch(selected, role => {
  checked.value = role ? [...role.permissionCodes] : [];
});

function groupState(list: Permission[]) {
  const count = list.filter(item => checked.value.includes(item.code)).length;
  return { all: count === list.length, some: count > 0 && count < list.length };
}

function toggleGroup(list: Permission[], value: boolean) {
  const codes = list.map(item => item.code);
  checked.value = value
    ? [...new Set([...checked.value, ...codes])]
    : checked.value.filter(code => !codes.includes(code));
}

async function save() {
  if (!selected.value) return;
  saving.value = true;
  const { error } = await setRolePermissions(selected.value.id, { permissionCodes: checked.value });
  saving.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  await load(selected.value.id);
}

function openForm(role: Role | null) {
  editing.value = role;
  formOpen.value = true;
}

function remove(role: Role) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.system.role.deleteConfirm', { name: role.roleName }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteRole(role.id);
      if (error) return;
      window.$message?.success($t('common.deleteSuccess'));
      selectedId.value = null;
      await load();
    }
  });
}
</script>

<template>
  <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
    <NGi span="24 m:8">
      <NCard :title="$t('page.system.role.title')" :bordered="false" size="small" class="card-wrapper h-full">
        <template #header-extra>
          <NButton size="small" type="primary" @click="openForm(null)">{{ $t('page.system.role.addTitle') }}</NButton>
        </template>
        <NSpin :show="loading">
          <NList hoverable clickable>
            <NListItem
              v-for="role in roles"
              :key="role.id"
              :class="{ 'text-primary': role.id === selectedId }"
              @click="selectedId = role.id"
            >
              <div class="flex items-center gap-8px">
                <div class="min-w-0 flex-1 flex-col">
                  <span class="font-600">{{ role.roleName }}</span>
                  <NText depth="3" class="font-mono text-12px">{{ role.roleCode }}</NText>
                </div>
                <NTag v-if="role.builtin" size="small" :bordered="false">{{ $t('page.system.role.builtin') }}</NTag>
                <NTag v-if="role.status === '2'" size="small" :bordered="false" type="warning">
                  {{ $t('page.system.user.statusOptions.2') }}
                </NTag>
                <NText depth="3" class="text-12px">{{ $t('page.system.role.users', { count: role.userCount }, { plural: role.userCount }) }}</NText>
              </div>
            </NListItem>
          </NList>
        </NSpin>
      </NCard>
    </NGi>
    <NGi span="24 m:16">
      <NCard
        :title="
          selected ? `${selected.roleName} · ${$t('page.system.role.permissions')}` : $t('page.system.role.permissions')
        "
        :bordered="false"
        size="small"
        class="card-wrapper h-full"
      >
        <template v-if="selected" #header-extra>
          <div class="flex gap-8px">
            <NButton size="small" @click="openForm(selected)">{{ $t('common.edit') }}</NButton>
            <NButton v-if="!selected.builtin" size="small" type="error" ghost @click="remove(selected)">
              {{ $t('common.delete') }}
            </NButton>
            <NButton v-if="!isSuper" size="small" type="primary" :disabled="!dirty" :loading="saving" @click="save">
              {{ $t('page.system.role.savePermissions') }}
            </NButton>
          </div>
        </template>
        <NEmpty v-if="!selected" :description="$t('page.system.role.selectRole')" />
        <NAlert v-else-if="isSuper" type="info" :bordered="false">{{ $t('page.system.role.superAll') }}</NAlert>
        <div v-else class="flex-col gap-16px">
          <section v-for="[group, list] in groups" :key="group" class="flex-col gap-8px">
            <!-- Keep group Select All outside NCheckboxGroup, which controls contained checkbox state. -->
            <NCheckbox
              :checked="groupState(list).all"
              :indeterminate="groupState(list).some"
              class="font-600"
              @update:checked="(value: boolean) => toggleGroup(list, value)"
            >
              {{ groupLabel(group) }}
            </NCheckbox>
            <NCheckboxGroup v-model:value="checked">
              <div class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-8px pl-24px">
                <NCheckbox v-for="permission in list" :key="permission.code" :value="permission.code">
                  <span>{{ permission.name }}</span>
                  <NText depth="3" class="ml-6px font-mono text-12px">{{ permission.code }}</NText>
                </NCheckbox>
              </div>
            </NCheckboxGroup>
          </section>
        </div>
      </NCard>
    </NGi>
    <RoleForm v-model:show="formOpen" :role="editing" @saved="id => load(id)" />
  </NGrid>
</template>
