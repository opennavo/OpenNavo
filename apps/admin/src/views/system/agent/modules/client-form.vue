<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { createAgentClient, updateAgentClient } from '@/service/api';
import type { Schemas } from '@/typings/api/opennavo';
import { $t } from '@/locales';

defineOptions({ name: 'AgentClientForm' });

// Create/edit Agent clients; each gets a machine account (R_AGENT) that cannot log into admin.
const props = defineProps<{ client: Schemas['AgentClient'] | null }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: [] }>();

const model = reactive({ name: '', notes: '' });
const saving = ref(false);
const editing = computed(() => Boolean(props.client));

watch(show, open => {
  if (!open) return;
  model.name = props.client?.name ?? '';
  model.notes = props.client?.notes ?? '';
}, { immediate: true });

async function save() {
  const name = model.name.trim();
  if (!name) {
    window.$message?.warning($t('page.system.agent.clientNameRequired'));
    return;
  }
  saving.value = true;
  const body = { name, notes: model.notes.trim() };
  const { error } = props.client ? await updateAgentClient(props.client.id, body) : await createAgentClient(body);
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
    :title="editing ? $t('page.system.agent.editClient') : $t('page.system.agent.addClient')"
    class="w-520px"
  >
    <NForm label-placement="left" label-width="auto">
      <NFormItem :label="$t('page.system.agent.clientName')" required>
        <NInput v-model:value="model.name" :maxlength="128" :placeholder="$t('page.system.agent.clientNamePlaceholder')" />
      </NFormItem>
      <NFormItem :label="$t('page.system.agent.clientNotes')">
        <NInput v-model:value="model.notes" type="textarea" :rows="3" :maxlength="2000" show-count />
      </NFormItem>
    </NForm>
    <NText v-if="!editing" depth="3" class="text-12px">{{ $t('page.system.agent.clientHint') }}</NText>
    <template #footer>
      <div class="flex justify-end gap-12px">
        <NButton @click="show = false">{{ $t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ $t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
