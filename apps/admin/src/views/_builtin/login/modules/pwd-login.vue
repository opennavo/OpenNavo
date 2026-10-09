<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useAuthStore } from '@/store/modules/auth';
import { useFormRules, useNaiveForm } from '@/hooks/common/form';
import { $t } from '@/locales';

defineOptions({
  name: 'PwdLogin'
});

const authStore = useAuthStore();
const { formRef, validate } = useNaiveForm();

interface FormModel {
  userName: string;
  password: string;
}

const model: FormModel = reactive({
  userName: '',
  password: ''
});

// Login validates required fields only; backend owns account/password rules (≥10 characters, arbitrary characters), and frontend must not be stricter.
const rules = computed<Record<keyof FormModel, App.Global.FormRule[]>>(() => {
  const { createRequiredRule } = useFormRules();

  return {
    userName: [createRequiredRule($t('form.userName.required'))],
    password: [createRequiredRule($t('form.pwd.required'))]
  };
});

async function handleSubmit() {
  await validate();
  await authStore.login(model.userName.trim(), model.password);
}
</script>

<template>
  <NForm ref="formRef" :model="model" :rules="rules" size="large" :show-label="false" @keyup.enter="handleSubmit">
    <NFormItem path="userName">
      <NInput
        v-model:value="model.userName"
        :input-props="{ autocomplete: 'username' }"
        :placeholder="$t('page.login.common.userNamePlaceholder')"
      />
    </NFormItem>
    <NFormItem path="password">
      <NInput
        v-model:value="model.password"
        type="password"
        show-password-on="click"
        :input-props="{ autocomplete: 'current-password' }"
        :placeholder="$t('page.login.common.passwordPlaceholder')"
      />
    </NFormItem>
    <NSpace vertical :size="16">
      <NButton type="primary" size="large" block :loading="authStore.loginLoading" @click="handleSubmit">
        {{ $t('page.login.common.login') }}
      </NButton>
      <NText depth="3" class="block text-center text-12px">{{ $t('page.login.pwdLogin.forgetPasswordHint') }}</NText>
    </NSpace>
  </NForm>
</template>

<style scoped></style>
