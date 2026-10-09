<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { formatPercent } from '@opennavo/shared';
import { useAppLocale } from '@/composables/useAppLocale';
import { OnButton } from '@opennavo/ui';
import SettingRow from './SettingRow.vue';
import { useToasts } from '@/composables/useToasts';
import { useTasksStore } from '@/stores';

// Desktop self-update (06 §4.1, §15): check → download/install with progress → restart.
// Rust refuses restart with active tasks (active_tasks); disable the button first and show rejection while tasks continue.
const props = defineProps<{ currentVersion: string | null }>();

const { t } = useI18n();
const { appLocale } = useAppLocale();
const tasks = useTasksStore();
const toasts = useToasts();

type State = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installed' | 'failed';
const state = ref<State>('idle');
const update = shallowRef<Update | null>(null);
const percent = ref<number | null>(null);
const busy = computed(() => tasks.active.length > 0);

const hint = computed(() => {
  switch (state.value) {
    case 'latest':
      return t('updater.latest');
    case 'available':
      return t('updater.available', { version: update.value?.version ?? '' });
    case 'downloading':
      return t('updater.downloading', {
        percent: formatPercent((percent.value ?? 0) / 100, { locale: appLocale.value })
      });
    case 'installed':
      return busy.value ? t('updater.busy') : t('updater.installed');
    case 'failed':
      return t('updater.failed');
    default:
      return props.currentVersion ? t('updater.current', { version: props.currentVersion }) : undefined;
  }
});

async function checkNow() {
  state.value = 'checking';
  try {
    update.value = await check();
    state.value = update.value ? 'available' : 'latest';
  } catch {
    state.value = 'failed';
  }
}

async function install() {
  if (!update.value) return;
  state.value = 'downloading';
  let total = 0;
  let done = 0;
  try {
    await update.value.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') {
        done += event.data.chunkLength;
        percent.value = total ? Math.min(100, Math.round((done / total) * 100)) : null;
      }
      if (event.event === 'Finished') percent.value = 100;
    });
    state.value = 'installed';
  } catch {
    state.value = 'failed';
  }
}

async function restart() {
  try {
    await relaunch();
  } catch (error) {
    toasts.push({
      tone: 'warning',
      title: String(error).includes('active_tasks') ? t('updater.busy') : t('errors.actionFailed')
    });
  }
}
</script>

<template>
  <SettingRow :label="t('updater.title')" :hint="hint">
    <OnButton v-if="state === 'available'" variant="primary" size="sm" icon="download" @click="install">
      {{ t('updater.install') }}
    </OnButton>
    <OnButton v-else-if="state === 'installed'" variant="primary" size="sm" :disabled="busy" @click="restart">
      {{ t('updater.restart') }}
    </OnButton>
    <OnButton
      v-else
      variant="secondary"
      size="sm"
      icon="refresh-cw"
      :loading="state === 'checking' || state === 'downloading'"
      @click="checkNow"
    >
      {{ t('updater.check') }}
    </OnButton>
  </SettingRow>
</template>
