<script setup lang="ts">
import { ref, watch } from 'vue';
import { createSynonym, updateSynonym } from '@/service/api';
import type { RecordOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'SynonymForm' });

// Synonyms: 2–10 terms, each ≤40 characters; pass synonym for editing, initialTerms when adding from zero-result searches.
const props = defineProps<{ synonym: RecordOf<'listSynonyms'> | null; initialTerms?: string[] }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [] }>();

const terms = ref<string[]>([]);
const enabled = ref(true);
const saving = ref(false);

watch(show, open => {
  if (!open) return;
  terms.value = props.synonym ? [...props.synonym.terms] : [...(props.initialTerms ?? [])];
  enabled.value = props.synonym?.enabled ?? true;
});

async function save() {
  const list = [...new Set(terms.value.map(term => term.trim()).filter(Boolean))];
  if (list.length < 2 || list.length > 10) {
    window.$message?.warning($t('page.ops.search.termsInvalid'));
    return;
  }
  saving.value = true;
  const body = { terms: list, enabled: enabled.value };
  const { error } = props.synonym ? await updateSynonym(props.synonym.id, body) : await createSynonym(body);
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
    :title="synonym ? $t('page.ops.search.editSynonym') : $t('page.ops.search.newSynonym')"
    class="w-520px"
  >
    <NForm label-placement="left" :label-width="72">
      <NFormItem :label="$t('page.ops.search.terms')" :feedback="$t('page.ops.search.termsHint')">
        <NDynamicTags v-model:value="terms" :max="10" :input-props="{ maxlength: 40 }" />
      </NFormItem>
      <NFormItem :label="$t('page.ops.search.columns.enabled')">
        <NSwitch v-model:value="enabled" />
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
