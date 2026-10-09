<script setup lang="ts">
import { computed } from 'vue';
import { useClipboard } from '@vueuse/core';
import type { DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';
import { hermesConfig } from './permissions';

defineOptions({ name: 'AgentTokenCreated' });

// Plaintext tokens appear only once in the creation response (11 §5); no page or log shows them after dismissal.
const props = defineProps<{ result: DataOf<'createAgentToken'> | null; mcpUrl: string }>();
const show = defineModel<boolean>('show', { required: true });

// Prevent accidental backdrop/Escape dismissal; bind as an object because hyphenated template attributes falsely match API-key prefixes in secret scanning.
const modalOptions = { maskClosable: false, closeOnEsc: false };

const { copy, copied } = useClipboard({ legacy: true });
const config = computed(() => hermesConfig(props.mcpUrl));

async function copyToken() {
  if (!props.result) return;
  await copy(props.result.plaintext);
  window.$message?.success($t('page.system.agent.copied'));
}

async function copyConfig() {
  await copy(config.value);
  window.$message?.success($t('page.system.agent.copied'));
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="$t('page.system.agent.tokenCreatedTitle')"
    v-bind="modalOptions"
    class="w-640px"
  >
    <div v-if="result" class="flex-col gap-16px">
      <NAlert type="warning" :show-icon="true">{{ $t('page.system.agent.tokenCreatedWarning') }}</NAlert>
      <div class="flex-col gap-6px">
        <NText depth="3" class="text-12px">{{ $t('page.system.agent.tokenPlaintext', { name: result.token.name }) }}</NText>
        <div class="flex items-center gap-8px">
          <NInput :value="result.plaintext" readonly class="font-mono" />
          <NButton type="primary" @click="copyToken">{{ copied ? $t('page.system.agent.copied') : $t('page.system.agent.copy') }}</NButton>
        </div>
      </div>
      <div class="flex-col gap-6px">
        <div class="flex items-center justify-between">
          <NText depth="3" class="text-12px">{{ $t('page.system.agent.configTitle') }}</NText>
          <NButton size="small" quaternary @click="copyConfig">{{ $t('page.system.agent.copy') }}</NButton>
        </div>
        <pre class="m-0 overflow-auto rounded-small bg-layout p-12px text-12px leading-[1.6]"><code>{{ config }}</code></pre>
        <NText depth="3" class="text-12px">{{ $t('page.system.agent.configHint') }}</NText>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end">
        <NButton type="primary" @click="show = false">{{ $t('page.system.agent.tokenSaved') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
