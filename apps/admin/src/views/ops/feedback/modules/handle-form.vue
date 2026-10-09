<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { updateFeedback } from '@/service/api';
import type { RecordOf, Schemas } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'HandleForm' });

// Process feedback with status and notes (≤2000 characters).
const props = defineProps<{ feedback: RecordOf<'listFeedback'> | null }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [] }>();

const status = ref<Schemas['FeedbackStatus']>('in_progress');
const note = ref('');
const saving = ref(false);

watch(show, open => {
  if (!open || !props.feedback) return;
  status.value = props.feedback.status === 'open' ? 'in_progress' : props.feedback.status;
  note.value = props.feedback.handlerNote ?? '';
});

const statusOptions = computed(() =>
  (['open', 'in_progress', 'resolved', 'rejected'] as const).map(value => ({
    value,
    label: $t(`page.ops.feedback.statuses.${value}`)
  }))
);

async function save() {
  if (!props.feedback) return;
  saving.value = true;
  const { error } = await updateFeedback(props.feedback.id, {
    status: status.value,
    handlerNote: note.value.trim() || null
  });
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
    :title="feedback ? $t('page.ops.feedback.handleTitle', { id: feedback.id }) : ''"
    class="w-560px"
  >
    <template v-if="feedback">
      <NText depth="2" tag="p" class="m-0 mb-12px whitespace-pre-wrap">{{ feedback.content }}</NText>
      <NForm label-placement="left" :label-width="72">
        <NFormItem :label="$t('page.ops.feedback.status')">
          <NSelect v-model:value="status" :options="statusOptions" />
        </NFormItem>
        <NFormItem :label="$t('page.ops.feedback.handlerNote')">
          <NInput v-model:value="note" type="textarea" :rows="4" :maxlength="2000" show-count />
        </NFormItem>
      </NForm>
    </template>
    <template #footer>
      <div class="flex justify-end gap-12px">
        <NButton @click="show = false">{{ $t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ $t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
