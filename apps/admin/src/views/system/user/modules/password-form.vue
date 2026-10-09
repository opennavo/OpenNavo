<script setup lang="ts">
import { ref, watch } from 'vue';
import type { FormInst } from 'naive-ui';
import { resetAdminUserPassword } from '@/service/api';
import type { RecordOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'PasswordForm' });

// Reset administrator password; backend also invalidates their existing sessions.
const props = defineProps<{ user: RecordOf<'listAdminUsers'> | null }>();
const show = defineModel<boolean>('show', { required: true });

const formRef = ref<FormInst | null>(null);
const model = ref({ newPassword: '' });
const saving = ref(false);

watch(show, open => {
  if (open) model.value = { newPassword: '' };
});

async function save() {
  if (!props.user) return;
  await formRef.value?.validate();
  saving.value = true;
  const { error } = await resetAdminUserPassword(props.user.id, { newPassword: model.value.newPassword });
  saving.value = false;
  if (error) return;
  window.$message?.success($t('page.system.user.resetDone'));
  show.value = false;
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="user ? $t('page.system.user.resetPasswordTitle', { name: user.userName }) : ''"
    class="w-480px"
  >
    <NForm
      ref="formRef"
      :model="model"
      :rules="{
        newPassword: [
          { required: true, message: $t('form.required'), trigger: ['blur', 'input'] },
          { min: 10, message: $t('page.system.user.passwordInvalid'), trigger: ['blur', 'input'] }
        ]
      }"
      label-placement="left"
      :label-width="88"
    >
      <NFormItem :label="$t('page.system.user.newPassword')" path="newPassword">
        <NInput
          v-model:value="model.newPassword"
          type="password"
          show-password-on="click"
          :maxlength="128"
          autocomplete="new-password"
        />
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
