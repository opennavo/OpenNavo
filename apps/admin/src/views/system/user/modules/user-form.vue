<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { createAdminUser, fetchRoles, updateAdminUser } from '@/service/api';
import type { BodyOf, DataOf, RecordOf } from '@/typings/api/opennavo';
import { REG_EMAIL } from '@/constants/reg';
import { $t } from '@/locales';

defineOptions({ name: 'UserForm' });

type Row = RecordOf<'listAdminUsers'>;
type Create = BodyOf<'createAdminUser'>;

// Create/edit administrators (07 §7.14): username/initial password (≥10 characters) on creation; only nickname, email, roles, status on edit.
const props = defineProps<{ user: Row | null }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [] }>();

const USER_NAME = /^[a-zA-Z0-9_.-]{3,32}$/;
const formRef = ref<FormInst | null>(null);
const saving = ref(false);
const roles = ref<DataOf<'listRoles'>>([]);
const model = reactive<Create>({ userName: '', password: '', nickName: '', email: null, status: '1', roles: [] });

watch(show, async open => {
  if (!open) return;
  Object.assign(
    model,
    props.user
      ? {
          userName: props.user.userName,
          password: '',
          nickName: props.user.nickName,
          email: props.user.email ?? null,
          status: props.user.status,
          roles: [...props.user.roles]
        }
      : { userName: '', password: '', nickName: '', email: null, status: '1', roles: [] }
  );
  if (!roles.value.length) {
    const { data, error } = await fetchRoles();
    if (!error) roles.value = data;
  }
});

const roleOptions = computed(() =>
  roles.value.map(role => ({ value: role.roleCode, label: `${role.roleName}（${role.roleCode}）` }))
);
const statusOptions = computed(() =>
  (['1', '2'] as const).map(value => ({ value, label: $t(`page.system.user.statusOptions.${value}`) }))
);

const rules = computed<FormRules>(() => {
  const required = { required: true, message: $t('form.required'), trigger: ['blur', 'input'] };
  return {
    userName: props.user
      ? []
      : [required, { pattern: USER_NAME, message: $t('page.system.user.userNameInvalid'), trigger: ['blur', 'input'] }],
    password: props.user
      ? []
      : [required, { min: 10, message: $t('page.system.user.passwordInvalid'), trigger: ['blur', 'input'] }],
    nickName: [required],
    email: [{ pattern: REG_EMAIL, message: $t('form.email.invalid'), trigger: ['blur', 'input'] }],
    roles: [{ type: 'array', required: true, min: 1, message: $t('form.required'), trigger: ['change'] }]
  };
});

async function save() {
  await formRef.value?.validate();
  saving.value = true;
  const email = model.email?.trim() ? model.email.trim() : null;
  const { error } = props.user
    ? await updateAdminUser(props.user.id, {
        nickName: model.nickName.trim(),
        email,
        status: model.status,
        roles: model.roles
      })
    : await createAdminUser({ ...model, userName: model.userName.trim(), nickName: model.nickName.trim(), email });
  saving.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  show.value = false;
  emit('saved');
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="user ? $t('page.system.user.editTitle') : $t('page.system.user.addTitle')"
    class="w-560px"
  >
    <NForm ref="formRef" :model="model" :rules="rules" label-placement="left" :label-width="88">
      <NFormItem :label="$t('page.system.user.userName')" path="userName">
        <NInput v-model:value="model.userName" :disabled="Boolean(user)" :maxlength="32" autocomplete="off" />
      </NFormItem>
      <NFormItem v-if="!user" :label="$t('page.system.user.password')" path="password">
        <NInput
          v-model:value="model.password"
          type="password"
          show-password-on="click"
          :maxlength="128"
          autocomplete="new-password"
        />
      </NFormItem>
      <NFormItem :label="$t('page.system.user.nickName')" path="nickName">
        <NInput v-model:value="model.nickName" :maxlength="64" />
      </NFormItem>
      <NFormItem :label="$t('page.system.user.email')" path="email">
        <NInput v-model:value="model.email" clearable />
      </NFormItem>
      <NFormItem :label="$t('page.system.user.roles')" path="roles">
        <NSelect v-model:value="model.roles" :options="roleOptions" multiple />
      </NFormItem>
      <NFormItem :label="$t('page.system.user.status')" path="status">
        <NRadioGroup v-model:value="model.status">
          <NRadio v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</NRadio>
        </NRadioGroup>
      </NFormItem>
    </NForm>
    <template #footer>
      <div class="flex justify-end gap-12px">
        <NButton @click="show = false">{{ $t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ $t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
