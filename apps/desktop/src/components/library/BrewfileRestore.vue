<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OnButton, OnChip, OnModal } from '@opennavo/ui';
import type { OnChipTone } from '@opennavo/ui';
import type { BrewfileDecisions, BrewfileEntryStatus, BrewfilePreview } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';
import { confirmationRefused } from '@/ipc/confirmation';
import { usePermissionGateStore } from '@/stores/permissionGate';
import { useTasksStore } from '@/stores/tasks';
import { usePackageState } from '@/composables/usePackageState';
import { useToasts } from '@/composables/useToasts';

// Brewfile restore preview (06 §6.3: parse internally, never invoke brew bundle). Installing goes through Rust: it reads
// the file again, refuses it if it changed since this preview, asks in OpenNavo's confirmation window, and queues the
// listed casks with trigger=bundle.
const props = defineProps<{ preview: BrewfilePreview | null; path: string | null }>();
const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const toasts = useToasts();
const tasks = useTasksStore();
const { errorText } = usePackageState();
const installing = ref(false);

const TONES: Record<BrewfileEntryStatus, OnChipTone> = {
  ready: 'accent',
  installed: 'success',
  skipped: 'neutral',
  unsupported: 'warning',
  invalid: 'danger',
  not_found: 'danger'
};

const ready = computed(() =>
  (props.preview?.entries ?? []).filter(entry => entry.status === 'ready' && entry.kind && entry.token)
);

async function install() {
  if (!props.preview || !props.path) return;
  const targets = ready.value.flatMap(entry =>
    entry.kind && entry.token ? [{ kind: entry.kind, token: entry.token }] : []
  );
  if (!(await usePermissionGateStore().require({ feature: 'install', targets }))) return;
  installing.value = true;
  try {
    open.value = false;
    // The same checks as a single install, one cask at a time: taps ask every time, existing apps ask before
    // adopting. Rust lists the answers in its window and binds them to the plan.
    const decisions: BrewfileDecisions = { adopt: [], taps: [], declined: [] };
    for (const target of targets) {
      const consent = await tasks.installConsent(target, 'bundle');
      if (!consent) decisions.declined.push(target.token);
      else {
        if (consent.adopt) decisions.adopt.push(target.token);
        if (consent.tap && !decisions.taps.includes(consent.tap)) decisions.taps.push(consent.tap);
      }
    }
    if (decisions.declined.length === targets.length) return;
    const queued = await unwrap(commands.brewfileInstall(props.path, props.preview.digest, decisions));
    queued.forEach(task => tasks.applyUpdate(task));
    if (!queued.length) return;
    toasts.push({
      tone: 'success',
      title: t('collections.queued', { count: queued.length }, { plural: queued.length })
    });
    open.value = false;
  } catch (error) {
    if (confirmationRefused(error)) return;
    toasts.push({
      tone: 'danger',
      title: t('errors.actionFailed'),
      description: errorText(error)
    });
  } finally {
    installing.value = false;
  }
}
</script>

<template>
  <OnModal
    v-model:open="open"
    size="md"
    :title="t('library.restore.title')"
    :description="
      preview
        ? t('library.restore.summary', {
            ready: preview.ready,
            installed: preview.installed,
            unsupported: preview.unsupported
          })
        : undefined
    "
  >
    <ul v-if="preview" class="m-0 flex max-h-360px list-none flex-col gap-6px overflow-y-auto p-0">
      <li v-for="entry in preview.entries" :key="entry.line" class="flex items-center gap-10px text-13px">
        <code class="min-w-0 flex-1 truncate font-mono text-12px text-ink-secondary">{{ entry.raw }}</code>
        <OnChip :tone="TONES[entry.status]">{{ t(`library.restore.status.${entry.status}`) }}</OnChip>
      </li>
    </ul>
    <template #footer>
      <OnButton variant="secondary" @click="open = false">{{ t('common.cancel') }}</OnButton>
      <OnButton variant="primary" :disabled="!ready.length" :loading="installing" @click="install">
        {{ t('library.restore.install', { count: ready.length }, { plural: ready.length }) }}
      </OnButton>
    </template>
  </OnModal>
</template>
