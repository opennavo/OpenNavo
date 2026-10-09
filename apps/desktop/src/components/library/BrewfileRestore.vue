<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OnButton, OnChip, OnModal } from '@opennavo/ui';
import type { OnChipTone } from '@opennavo/ui';
import type { BrewfileEntryStatus, BrewfilePreview } from '@/ipc/bindings';
import { useTasksStore } from '@/stores/tasks';
import { usePackageState } from '@/composables/usePackageState';
import { useToasts } from '@/composables/useToasts';

// Brewfile restore preview (06 §6.3: parse internally, never invoke brew bundle); enqueue installable entries with trigger=bundle and explain others.
const props = defineProps<{ preview: BrewfilePreview | null }>();
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
  installing.value = true;
  try {
    const targets = ready.value.flatMap(entry =>
      entry.kind && entry.token ? [{ kind: entry.kind, token: entry.token }] : []
    );
    open.value = false;
    const queued = await tasks.enqueueMany('install', targets, 'bundle');
    if (!queued.length) return;
    toasts.push({
      tone: 'success',
      title: t('collections.queued', { count: queued.length }, { plural: queued.length })
    });
    open.value = false;
  } catch (error) {
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
