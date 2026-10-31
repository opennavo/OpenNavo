<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OnButton, OnCard, OnChip, OnSegmented, OnToggle } from '@opennavo/ui';
import SettingRow from './SettingRow.vue';
import type { McpStatus } from '@/ipc/bindings';
import { commands } from '@/ipc/client';
import { useToasts } from '@/composables/useToasts';
import { MCP_CLIENTS, copiedMcpPath, mcpAppMoved, mcpConfig, rememberCopiedMcpPath } from '@/utils/mcpConfig';
import type { McpClient } from '@/utils/mcpConfig';

// Settings → Local MCP. The switches are never updated optimistically: every change shows the state the
// backend reports afterwards. When turning something off fails, the backend keeps it on, so this page
// says "still on" instead of looking off while AI apps can still connect.
type Failure = 'offFailed' | 'writeOffFailed' | 'changeFailed';

const { t } = useI18n();
const toasts = useToasts();
const status = ref<McpStatus | null>(null);
const busy = ref(false);
const failure = ref<Failure | null>(null);
const client = ref<McpClient>('claude');
const copied = ref<string | null>(copiedMcpPath());

async function refresh() {
  status.value = await commands.mcpStatus();
}
onMounted(refresh);

async function change(kind: 'enabled' | 'write', next: boolean) {
  if (busy.value || !status.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const result = kind === 'enabled' ? await commands.mcpSetEnabled(next) : await commands.mcpSetWriteEnabled(next);
    if (result.status === 'ok') {
      status.value = result.data;
      return;
    }
    await refresh();
    const stillOn = kind === 'enabled' ? status.value?.enabled : status.value?.writeEnabled;
    failure.value = !next && stillOn ? (kind === 'enabled' ? 'offFailed' : 'writeOffFailed') : 'changeFailed';
  } catch {
    await refresh().catch(() => undefined);
    failure.value = 'changeFailed';
  } finally {
    busy.value = false;
  }
}

const clients = computed(() => MCP_CLIENTS.map(value => ({ value, label: t(`settings.mcp.clients.${value}`) })));
const commandPath = computed(() => status.value?.commandPath ?? null);
const config = computed(() => (commandPath.value ? mcpConfig(client.value, commandPath.value) : ''));
const moved = computed(() => mcpAppMoved(commandPath.value, copied.value));

async function copyConfig() {
  if (!commandPath.value) return;
  try {
    await navigator.clipboard.writeText(config.value);
  } catch {
    toasts.push({ tone: 'danger', title: t('settings.mcp.copyFailed') });
    return;
  }
  rememberCopiedMcpPath(commandPath.value);
  copied.value = commandPath.value;
  toasts.push({
    tone: 'success',
    title: t('settings.mcp.copied', { client: t(`settings.mcp.clients.${client.value}`) })
  });
}
</script>

<template>
  <div v-if="status" class="flex flex-col gap-16px">
    <OnCard padding="none">
      <SettingRow :label="t('settings.mcp.enable')" :hint="t('settings.mcp.enableHint')" label-id="setting-mcpEnabled">
        <OnChip v-if="failure === 'offFailed' && status.enabled" tone="warning" dot data-test="mcp-still-on">{{
          t('settings.mcp.stillOn')
        }}</OnChip>
        <OnToggle
          :model-value="status.enabled"
          :disabled="busy"
          aria-labelledby="setting-mcpEnabled"
          data-test="mcp-enabled"
          @update:model-value="value => change('enabled', value)"
        />
      </SettingRow>
      <SettingRow :label="t('settings.mcp.write')" :hint="t('settings.mcp.writeHint')" label-id="setting-mcpWrite">
        <OnChip
          v-if="failure === 'writeOffFailed' && status.writeEnabled"
          tone="warning"
          dot
          data-test="mcp-write-still-on"
          >{{ t('settings.mcp.stillOn') }}</OnChip
        >
        <OnToggle
          :model-value="status.writeEnabled"
          :disabled="busy || !status.enabled"
          aria-labelledby="setting-mcpWrite"
          data-test="mcp-write"
          @update:model-value="value => change('write', value)"
        />
      </SettingRow>
      <div
        v-if="failure"
        role="alert"
        class="border-t border-t-solid border-line-subtle px-18px py-12px text-12.5px text-status-danger"
        data-test="mcp-failure"
      >
        {{ t(`settings.mcp.${failure}`) }}
        <span v-if="status.error" class="mt-2px block font-mono text-11.5px text-ink-tertiary">{{ status.error }}</span>
      </div>
    </OnCard>

    <OnCard padding="none">
      <header class="border-b border-b-solid border-line-subtle px-18px py-14px">
        <h2 class="m-0 text-15px font-600 text-ink-primary">{{ t('settings.mcp.config') }}</h2>
        <p class="m-0 mt-4px text-12.5px text-ink-tertiary">{{ t('settings.mcp.configHint') }}</p>
      </header>
      <div class="flex flex-col gap-12px px-18px py-14px">
        <p v-if="moved" role="status" class="m-0 text-12.5px text-status-warning" data-test="mcp-moved">
          {{ t('settings.mcp.moved') }}
        </p>
        <div class="flex flex-wrap items-center justify-between gap-8px">
          <OnSegmented v-model="client" :options="clients" size="sm" :aria-label="t('settings.mcp.config')" />
          <OnButton size="sm" icon="copy" :disabled="!commandPath" data-test="mcp-copy" @click="copyConfig">{{
            t('settings.mcp.copy')
          }}</OnButton>
        </div>
        <pre
          v-if="commandPath"
          class="m-0 overflow-x-auto rounded-default border border-solid border-line-subtle bg-surface-inset px-14px py-12px font-mono text-12px leading-[1.7] text-ink-secondary"
          data-test="mcp-config"
          >{{ config }}</pre
        >
        <p v-else class="m-0 text-12.5px text-status-danger">{{ t('settings.mcp.pathUnavailable') }}</p>
      </div>
    </OnCard>
  </div>
</template>
