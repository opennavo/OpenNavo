<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInst, FormItemRule, FormRules } from 'naive-ui';
import { createMirror, updateMirror } from '@/service/api';
import type { BodyOf, DataOf } from '@/typings/api/opennavo';
import LocalizedFields from '@/components/opennavo/localized-fields.vue';
import type { LocalizedField } from '@/components/opennavo/localized-fields.vue';
import { DEFAULT_SOURCE_LOCALE, blankTexts, fromView, localizedBody } from '@/utils/content-locale';
import type { LocalizedStatuses, LocalizedTexts } from '@/utils/content-locale';
import { $t } from '@/locales';

defineOptions({ name: 'MirrorForm' });

type Mirror = DataOf<'listMirrors'>[number];
type Upsert = BodyOf<'createMirror'>;
type Form = Omit<Upsert, 'i18n'> & { i18n: LocalizedTexts };

// Mirror fields (07 §7.13): key, source name (others AI-translated), four URLs (all empty for official), probe URL, recommendation, enabled, order.
// Desktop always supplies official (first-launch-onboarding D2); its key, four URLs, and enabled state are immutable.
const props = defineProps<{ mirror: Mirror | null }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [] }>();
const official = computed(() => props.mirror?.key === 'official');

const KEY = /^[a-z0-9-]+$/;
const HTTPS = /^https:\/\/\S+$/;
const ADDRESSES = ['apiDomain', 'bottleDomain', 'brewGitRemote', 'coreGitRemote'] as const;

const TEXT_KEYS = ['name'] as const;
const fields = computed<LocalizedField[]>(() => [
  { key: 'name', label: $t('page.release.mirror.form.name'), maxlength: 40, required: true }
]);

const formRef = ref<FormInst | null>(null);
const saving = ref(false);
// Initial names/statuses: submit only source and modified languages when saving (04 §9.1).
const original = ref<LocalizedTexts>({});
const statuses = ref<LocalizedStatuses>({});
const blank = (): Form => ({
  key: '',
  sourceLocale: DEFAULT_SOURCE_LOCALE,
  i18n: blankTexts(TEXT_KEYS),
  apiDomain: null,
  bottleDomain: null,
  brewGitRemote: null,
  coreGitRemote: null,
  probeUrl: '',
  recommended: false,
  enabled: true,
  sort: 0
});
const model = reactive<Form>(blank());

watch(show, open => {
  if (!open) return;
  const mirror = props.mirror;
  const view = mirror ? fromView(mirror.i18n, TEXT_KEYS) : { texts: {}, statuses: {} };
  original.value = structuredClone(view.texts);
  statuses.value = view.statuses;
  Object.assign(
    model,
    mirror
      ? {
          key: mirror.key,
          sourceLocale: mirror.sourceLocale ?? DEFAULT_SOURCE_LOCALE,
          i18n: view.texts,
          apiDomain: mirror.apiDomain ?? null,
          bottleDomain: mirror.bottleDomain ?? null,
          brewGitRemote: mirror.brewGitRemote ?? null,
          coreGitRemote: mirror.coreGitRemote ?? null,
          probeUrl: mirror.probeUrl,
          recommended: mirror.recommended,
          enabled: mirror.enabled,
          sort: mirror.sort
        }
      : blank()
  );
});

const optionalUrl = {
  validator: (_rule: FormItemRule, value: string | null) => !value?.trim() || HTTPS.test(value.trim()),
  message: $t('page.release.mirror.form.urlInvalid'),
  trigger: ['blur', 'input']
};
const rules = computed<FormRules>(() => ({
  key: [
    { required: true, message: $t('form.required'), trigger: ['blur', 'input'] },
    { pattern: KEY, message: $t('page.release.mirror.form.keyInvalid'), trigger: ['blur', 'input'] }
  ],
  probeUrl: [
    { required: true, message: $t('form.required'), trigger: ['blur', 'input'] },
    { pattern: HTTPS, message: $t('page.release.mirror.form.urlInvalid'), trigger: ['blur', 'input'] }
  ],
  ...Object.fromEntries(ADDRESSES.map(key => [key, optionalUrl]))
}));

async function save() {
  await formRef.value?.validate();
  const body: Upsert = {
    ...model,
    key: model.key.trim(),
    i18n: localizedBody({
      texts: model.i18n,
      original: original.value,
      sourceLocale: model.sourceLocale,
      keys: TEXT_KEYS,
      entry: text => ({ name: text.name ?? '' })
    }),
    probeUrl: model.probeUrl.trim(),
    ...Object.fromEntries(ADDRESSES.map(key => [key, model[key]?.trim() || null]))
  };
  saving.value = true;
  const { error } = props.mirror ? await updateMirror(props.mirror.id, body) : await createMirror(body);
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
    :title="mirror ? $t('page.release.mirror.editTitle') : $t('page.release.mirror.create')"
    class="w-640px"
  >
    <NForm ref="formRef" :model="model" :rules="rules" label-placement="left" :label-width="110">
      <NAlert v-if="official" type="info" :show-icon="false" class="mb-16px">
        {{ $t('page.release.mirror.form.officialLocked') }}
      </NAlert>
      <NFormItem :label="$t('page.release.mirror.form.key')" path="key">
        <NInput v-model:value="model.key" :maxlength="20" :disabled="official" class="font-mono" />
      </NFormItem>
      <LocalizedFields
        v-model:source-locale="model.sourceLocale"
        v-model:texts="model.i18n"
        :fields="fields"
        :statuses="statuses"
      />
      <NFormItem v-for="key in ADDRESSES" :key="key" :label="$t(`page.release.mirror.form.${key}`)" :path="key">
        <NInput v-model:value="model[key]" clearable :disabled="official" class="font-mono" />
      </NFormItem>
      <NText depth="3" tag="p" class="m-0 mb-16px pl-110px text-12px">
        {{ $t('page.release.mirror.form.officialHint') }}
      </NText>
      <NFormItem :label="$t('page.release.mirror.form.probeUrl')" path="probeUrl">
        <NInput v-model:value="model.probeUrl" class="font-mono" />
      </NFormItem>
      <NText depth="3" tag="p" class="m-0 mb-16px pl-110px text-12px">
        {{ $t('page.release.mirror.form.probeUrlHint') }}
      </NText>
      <div class="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-x-16px">
        <NFormItem :label="$t('page.release.mirror.form.recommended')" label-placement="top">
          <NSwitch v-model:value="model.recommended" />
        </NFormItem>
        <NFormItem :label="$t('page.release.mirror.form.enabled')" label-placement="top">
          <NSwitch v-model:value="model.enabled" :disabled="official" />
        </NFormItem>
        <NFormItem :label="$t('page.release.mirror.form.sort')" label-placement="top">
          <NInputNumber v-model:value="model.sort" :min="0" class="w-full" />
        </NFormItem>
      </div>
      <NText depth="3" tag="p" class="m-0 text-12px">{{ $t('page.release.mirror.form.recommendedHint') }}</NText>
    </NForm>
    <template #footer>
      <div class="flex justify-end gap-12px">
        <NButton @click="show = false">{{ $t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ $t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
