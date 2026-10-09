<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { fetchGitHubSettings, updateGitHubSettings } from '@/service/api';
import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'GitHubSettings' });

const settings = ref<DataOf<'getGitHubSettings'>>();
const token = ref('');
const form = ref<FormInst>();
const loading = ref(false);
const saving = ref(false);
const loadFailed = ref(false);
const saveFailed = ref(false);
let disposed = false;
const model = computed(() => ({ token: token.value }));
const rules = computed<FormRules>(() => ({
  token: {
    validator: () => token.value.length <= 4096 && /^[\x21-\x7e]*$/u.test(token.value),
    message: $t('page.system.github.invalidToken'),
    trigger: ['input', 'blur']
  }
}));

async function load() {
  if (loading.value || saving.value) return;
  loading.value = true;
  loadFailed.value = false;
  try {
    const { data, error } = await fetchGitHubSettings();
    if (disposed) return;
    if (error) loadFailed.value = true;
    else settings.value = data;
  } finally {
    loading.value = false;
  }
}

async function update(body: BodyOf<'updateGitHubSettings'>) {
  if (!settings.value || saving.value || loading.value || loadFailed.value) return;
  saving.value = true;
  saveFailed.value = false;
  try {
    const { data, error } = await updateGitHubSettings(body);
    if (disposed) return;
    if (error) saveFailed.value = true;
    else {
      settings.value = data;
      token.value = '';
      form.value?.restoreValidation();
      window.$message?.success($t('page.shared.saved'));
    }
  } finally {
    saving.value = false;
  }
}

async function save() {
  if (!token.value || saving.value || loading.value) return;
  try {
    await form.value?.validate();
  } catch {
    return;
  }
  await update({ token: token.value, clearToken: false });
}

onBeforeUnmount(() => {
  disposed = true;
  token.value = '';
});
void load();
</script>

<template>
  <NCard :title="$t('page.system.github.title')" :bordered="false" class="card-wrapper">
    <template #header-extra>
      <NButton :loading="loading" :disabled="saving" @click="load">{{ $t('common.refresh') }}</NButton>
    </template>
    <div class="max-w-720px">
      <NP class="mt-0">{{ $t('page.system.github.scope') }}</NP>
      <NP>
        {{ $t('page.system.github.permissionsHint') }}
        <NA
          href="https://docs.github.com/en/rest/commits/commits#list-commits"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('page.system.github.permissionsLink') }}
        </NA>
      </NP>
      <NAlert v-if="loadFailed" type="error" class="mb-20px">{{ $t('page.system.github.loadFailed') }}</NAlert>
      <NSkeleton v-if="loading && !settings" text :repeat="3" />
      <NForm
        v-if="settings"
        ref="form"
        :model="model"
        :rules="rules"
        label-placement="top"
        :disabled="saving || loading || loadFailed"
      >
        <NFormItem :label="$t('page.system.github.token')" path="token">
          <div class="w-full">
            <NInput
              v-model:value="token"
              type="password"
              :maxlength="4096"
              :placeholder="$t('page.system.github.tokenPlaceholder')"
              :input-props="{
                autocomplete: 'new-password',
                spellcheck: false,
                'aria-label': $t('page.system.github.token')
              }"
            />
            <div class="mt-8px flex flex-wrap items-center gap-8px">
              <NTag
                size="small"
                :type="settings.tokenConfigured ? 'success' : 'warning'"
                class="h-auto! max-w-full py-2px"
              >
                <span class="whitespace-normal leading-normal">
                  {{ $t(`page.system.github.tokenSource.${settings.tokenSource}`) }}
                </span>
              </NTag>
              <NText depth="3">{{ $t('page.system.github.tokenHint') }}</NText>
            </div>
          </div>
        </NFormItem>
        <NAlert v-if="saveFailed" type="error" class="mb-20px">{{ $t('page.system.github.saveFailed') }}</NAlert>
        <div class="flex flex-wrap items-center gap-12px">
          <NButton type="primary" :loading="saving" :disabled="!token || loading || loadFailed" @click="save">
            {{ $t('page.system.github.save') }}
          </NButton>
          <NPopconfirm
            v-if="settings.tokenSource === 'admin'"
            :disabled="saving || loading || loadFailed || Boolean(token)"
            :positive-button-props="{ type: 'error' }"
            @positive-click="update({ clearToken: true })"
          >
            <template #trigger>
              <NButton type="error" secondary :disabled="saving || loading || loadFailed || Boolean(token)">
                {{ $t('page.system.github.clearToken') }}
              </NButton>
            </template>
            {{ $t('page.system.github.clearNone') }}
          </NPopconfirm>
          <NText depth="3">{{ $t('page.system.github.effect') }}</NText>
        </div>
      </NForm>
    </div>
  </NCard>
</template>
