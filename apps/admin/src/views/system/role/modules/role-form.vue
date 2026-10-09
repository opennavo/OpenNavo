<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { createRole, updateRole } from '@/service/api';
import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'RoleForm' });

type Role = DataOf<'listRoles'>[number];

// Create/edit roles: code ^R_[A-Z0-9_]+$; built-in role codes are immutable.
const props = defineProps<{ role: Role | null }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [id?: number] }>();

const formRef = ref<FormInst | null>(null);
const saving = ref(false);
const model = reactive<BodyOf<'createRole'>>({ roleCode: 'R_', roleName: '', roleDesc: null, status: '1' });

watch(show, open => {
  if (!open) return;
  Object.assign(
    model,
    props.role
      ? {
          roleCode: props.role.roleCode,
          roleName: props.role.roleName,
          roleDesc: props.role.roleDesc ?? null,
          status: props.role.status
        }
      : { roleCode: 'R_', roleName: '', roleDesc: null, status: '1' }
  );
});

const rules = computed<FormRules>(() => ({
  roleCode: [
    { required: true, message: $t('form.required'), trigger: ['blur', 'input'] },
    { pattern: /^R_[A-Z0-9_]+$/, message: $t('page.system.role.roleCodeInvalid'), trigger: ['blur', 'input'] }
  ],
  roleName: [{ required: true, message: $t('form.required'), trigger: ['blur', 'input'] }]
}));

async function save() {
  await formRef.value?.validate();
  saving.value = true;
  const body = {
    ...model,
    roleName: model.roleName.trim(),
    roleDesc: model.roleDesc?.trim() ? model.roleDesc.trim() : null
  };
  const result = props.role ? await updateRole(props.role.id, body) : await createRole(body);
  saving.value = false;
  if (result.error) return;
  window.$message?.success($t('page.shared.saved'));
  show.value = false;
  emit('saved', props.role?.id ?? (result.data as { id?: number } | null)?.id);
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="role ? $t('page.system.role.editTitle') : $t('page.system.role.addTitle')"
    class="w-520px"
  >
    <NForm ref="formRef" :model="model" :rules="rules" label-placement="left" :label-width="80">
      <NFormItem :label="$t('page.system.role.roleCode')" path="roleCode">
        <NInput v-model:value="model.roleCode" :disabled="Boolean(role?.builtin)" class="font-mono" />
      </NFormItem>
      <NFormItem :label="$t('page.system.role.roleName')" path="roleName">
        <NInput v-model:value="model.roleName" :maxlength="32" />
      </NFormItem>
      <NFormItem :label="$t('page.system.role.roleDesc')" path="roleDesc">
        <NInput v-model:value="model.roleDesc" type="textarea" :rows="2" :maxlength="200" show-count />
      </NFormItem>
      <NFormItem :label="$t('page.system.role.status')" path="status">
        <NRadioGroup v-model:value="model.status">
          <NRadio value="1">{{ $t('page.system.user.statusOptions.1') }}</NRadio>
          <NRadio value="2">{{ $t('page.system.user.statusOptions.2') }}</NRadio>
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
