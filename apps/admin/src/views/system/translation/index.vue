<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { fetchTranslationModels, fetchTranslationSettings, updateTranslationSettings } from '@/service/api';
import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'TranslationSettings' });

type Settings = DataOf<'getTranslationSettings'>;
const ready = ref(false);
const settings = ref<Settings>({
  enabled: false,
  baseUrl: '',
  model: '',
  reasoningEffort: 'medium',
  monthlyTokenBudget: 1,
  apiKeyConfigured: false,
  environmentKeyConfigured: false,
  apiKeySource: 'none'
});
const draft = ref<BodyOf<'updateTranslationSettings'>>({
  enabled: false,
  baseUrl: '',
  model: '',
  reasoningEffort: 'medium',
  monthlyTokenBudget: 1,
  apiKey: '',
  clearApiKey: false
});
const form = ref<FormInst>();
const loading = ref(false);
const saving = ref(false);
const loadFailed = ref(false);
const saveFailed = ref(false);
const baseline = ref('');
const modelIds = ref<string[]>([]);
const modelsLoading = ref(false);
const modelsFailed = ref(false);
const modelsLoaded = ref(false);
let modelsGeneration = 0;
const modelOptions = computed(() => {
  const ids = [...modelIds.value];
  if (draft.value.model && !ids.includes(draft.value.model)) ids.unshift(draft.value.model);
  return ids.map(value => ({ value, label: value }));
});
const canFetchModels = computed(() =>
  Boolean(
    draft.value.apiKey ||
    settings.value.environmentKeyConfigured ||
    (settings.value.apiKeyConfigured && !draft.value.clearApiKey)
  )
);
watch(
  () => [draft.value.baseUrl, draft.value.apiKey, draft.value.clearApiKey],
  () => {
    modelsGeneration += 1;
    modelIds.value = [];
    modelsLoaded.value = false;
    modelsFailed.value = false;
    modelsLoading.value = false;
  },
  { flush: 'sync' }
);
const dirty = computed(() => ready.value && JSON.stringify(draft.value) !== baseline.value);
const effortOptions = computed(() =>
  ['low', 'medium', 'high'].map(value => ({
    value,
    label: $t(`page.system.translation.${value}` as App.I18n.I18nKey)
  }))
);
const maximum = Number.MAX_SAFE_INTEGER;
const rules = computed<FormRules>(() => ({
  baseUrl: {
    validator: () => {
      try {
        const url = new URL(draft.value?.baseUrl ?? '');
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    },
    message: $t('page.system.translation.invalidUrl'),
    trigger: ['input', 'blur']
  },
  model: {
    validator: () =>
      Boolean(
        draft.value?.model &&
        draft.value.model.length <= 200 &&
        !/\s/u.test(draft.value.model) &&
        ![...draft.value.model].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ),
    message: $t('page.system.translation.invalidModel'),
    trigger: ['input', 'blur']
  },
  monthlyTokenBudget: {
    validator: () =>
      Number.isSafeInteger(draft.value?.monthlyTokenBudget) &&
      (draft.value?.monthlyTokenBudget ?? 0) > 0 &&
      (draft.value?.monthlyTokenBudget ?? 0) <= maximum,
    message: $t('page.system.translation.invalidBudget'),
    trigger: ['input', 'blur']
  },
  apiKey: {
    validator: () =>
      !draft.value?.enabled ||
      Boolean(draft.value.apiKey?.trim()) ||
      Boolean(settings.value?.apiKeyConfigured && !draft.value.clearApiKey) ||
      settings.value?.environmentKeyConfigured,
    message: $t('page.system.translation.keyRequired'),
    trigger: ['input', 'blur']
  }
}));

async function loadModels() {
  if (!canFetchModels.value || modelsLoading.value) return;
  try {
    await form.value?.validate(undefined, rule => rule === rules.value.baseUrl);
  } catch {
    return;
  }
  const generation = ++modelsGeneration;
  modelsLoading.value = true;
  modelsFailed.value = false;
  modelsLoaded.value = false;
  modelIds.value = [];
  try {
    const { data, error } = await fetchTranslationModels({
      baseUrl: draft.value.baseUrl,
      apiKey: draft.value.apiKey,
      clearApiKey: draft.value.clearApiKey
    });
    if (generation !== modelsGeneration) return;
    if (error) modelsFailed.value = true;
    else {
      modelIds.value = data.models;
      modelsLoaded.value = true;
    }
  } finally {
    if (generation === modelsGeneration) modelsLoading.value = false;
  }
}

function apply(value: Settings) {
  ready.value = true;
  settings.value = value;
  draft.value = {
    enabled: value.enabled,
    baseUrl: value.baseUrl,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    monthlyTokenBudget: value.monthlyTokenBudget,
    apiKey: '',
    clearApiKey: false
  };
  baseline.value = JSON.stringify(draft.value);
  form.value?.restoreValidation();
}
async function load() {
  loading.value = true;
  loadFailed.value = false;
  try {
    const { data, error } = await fetchTranslationSettings();
    if (error) loadFailed.value = true;
    else {
      apply(data);
      void loadModels();
    }
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!draft.value || saving.value || loading.value) return;
  try {
    await form.value?.validate();
  } catch {
    return;
  }
  saving.value = true;
  saveFailed.value = false;
  try {
    const { data, error } = await updateTranslationSettings({ ...draft.value });
    if (error) saveFailed.value = true;
    else {
      apply(data);
      void loadModels();
      window.$message?.success($t('page.shared.saved'));
    }
  } finally {
    saving.value = false;
  }
}
onBeforeUnmount(() => {
  modelsGeneration += 1;
  if (draft.value) draft.value.apiKey = '';
});
void load();
</script>

<template>
  <NCard :title="$t('page.system.translation.title')" :bordered="false" class="card-wrapper">
    <template #header-extra>
      <NButton :loading="loading" :disabled="saving" @click="load">{{ $t('common.refresh') }}</NButton>
    </template>
    <div class="max-w-720px">
      <NP class="mt-0">{{ $t('page.system.translation.scope') }}</NP>
      <NAlert v-if="loadFailed" type="error" class="mb-20px">{{ $t('page.system.translation.loadFailed') }}</NAlert>
      <NSkeleton v-if="loading && !ready" text :repeat="6" />
      <NForm v-if="ready" ref="form" :model="draft" :rules="rules" label-placement="top" :disabled="saving || loading">
        <NFormItem :label="$t('page.system.translation.enabled')" path="enabled">
          <NSwitch v-model:value="draft.enabled" :aria-label="$t('page.system.translation.enabled')" />
        </NFormItem>
        <NFormItem :label="$t('page.system.translation.baseUrl')" path="baseUrl">
          <NInput
            v-model:value="draft.baseUrl"
            :maxlength="2048"
            placeholder="https://gateway.example/v1"
            :input-props="{
              autocomplete: 'off',
              'aria-label': $t('page.system.translation.baseUrl')
            }"
          />
        </NFormItem>
        <NFormItem :label="$t('page.system.translation.apiKey')" path="apiKey">
          <div class="w-full">
            <NInput
              v-model:value="draft.apiKey"
              type="password"
              :maxlength="4096"
              :disabled="draft.clearApiKey"
              :placeholder="$t('page.system.translation.keyPlaceholder')"
              :input-props="{
                autocomplete: 'new-password',
                'aria-label': $t('page.system.translation.apiKey')
              }"
            />
            <div class="mt-8px flex flex-wrap items-center gap-8px">
              <NTag size="small" :type="settings.apiKeyConfigured ? 'success' : 'warning'">
                {{ $t(`page.system.translation.keySource.${settings.apiKeySource}`) }}
              </NTag>
              <NText depth="3">{{ $t('page.system.translation.keyHint') }}</NText>
            </div>
          </div>
        </NFormItem>
        <NFormItem v-if="settings.apiKeySource === 'admin'" :label="$t('page.system.translation.clearKey')">
          <div class="flex items-center gap-12px">
            <NSwitch
              v-model:value="draft.clearApiKey"
              :disabled="Boolean(draft.apiKey)"
              :aria-label="$t('page.system.translation.clearKey')"
            />
            <NText depth="3">{{ $t('page.system.translation.clearHint') }}</NText>
          </div>
        </NFormItem>
        <div class="grid grid-cols-1 gap-x-20px sm:grid-cols-2">
          <NFormItem :label="$t('page.system.translation.model')" path="model">
            <div class="w-full">
              <NSelect
                v-model:value="draft.model"
                filterable
                tag
                :options="modelOptions"
                :loading="modelsLoading"
                :placeholder="$t('page.system.translation.modelPlaceholder')"
                :input-props="{ 'aria-label': $t('page.system.translation.model'), maxlength: 200 }"
              />
              <NButton
                class="mt-8px"
                size="small"
                :loading="modelsLoading"
                :disabled="!canFetchModels || saving || loading"
                @click="loadModels"
              >
                {{ $t('page.system.translation.fetchModels') }}
              </NButton>
              <NText depth="3" class="mt-8px block">{{ $t('page.system.translation.modelsHint') }}</NText>
              <NAlert v-if="modelsFailed" type="error" class="mt-8px">
                {{ $t('page.system.translation.modelsFailed') }}
              </NAlert>
              <NText v-else-if="modelsLoaded && !modelIds.length" depth="3" class="mt-8px block">
                {{ $t('page.system.translation.modelsEmpty') }}
              </NText>
            </div>
          </NFormItem>
          <NFormItem :label="$t('page.system.translation.reasoningEffort')" path="reasoningEffort" class="self-start">
            <NSelect
              v-model:value="draft.reasoningEffort"
              :options="effortOptions"
              :aria-label="$t('page.system.translation.reasoningEffort')"
            />
          </NFormItem>
        </div>
        <NFormItem :label="$t('page.system.translation.monthlyTokenBudget')" path="monthlyTokenBudget">
          <div class="w-full">
            <NInputNumber
              :value="draft.monthlyTokenBudget"
              :min="1"
              :max="maximum"
              :precision="0"
              :input-props="{
                'aria-label': $t('page.system.translation.monthlyTokenBudget')
              }"
              class="w-full"
              @update:value="value => draft && (draft.monthlyTokenBudget = value ?? 0)"
            />
          </div>
        </NFormItem>
        <NAlert v-if="saveFailed" type="error" class="mb-20px">{{ $t('page.system.translation.saveFailed') }}</NAlert>
        <div class="flex items-center gap-12px">
          <NButton type="primary" :loading="saving" :disabled="!dirty || loading" @click="save">
            {{ $t('page.system.translation.save') }}
          </NButton>
          <NText depth="3">{{ $t('page.system.translation.effect') }}</NText>
        </div>
      </NForm>
    </div>
  </NCard>
</template>
