<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatDate, formatDuration, formatTime, formatVersionChange } from '@opennavo/shared';
import { OnAppIcon, OnButton, OnChip, OnLogViewer, OnModal } from '@opennavo/ui';
import type { Task } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';
import { useAppLocale } from '@/composables/useAppLocale';
import { usePackageIdentity } from '@/composables/usePackageIdentity';
import { usePackageState } from '@/composables/usePackageState';
import { useToasts } from '@/composables/useToasts';
import { useTasksStore } from '@/stores';
import { isDeferredUpdate } from '@/stores/runningApps';
import { retryOptions } from '@/stores/permissionPrompt';

// Local history (mockup 05, 06 §8: completed tasks), grouped by day; failures show reasons, logs, and retry (trigger=retry).
const props = defineProps<{ tasks: readonly Task[] }>();

const { t, te } = useI18n();
const { appLocale } = useAppLocale();
const { displayName, icon } = usePackageIdentity();
const { errorText } = usePackageState();
const queue = useTasksStore();
const toasts = useToasts();

const DAY = 24 * 60 * 60 * 1000;

function dayLabel(at: number): string {
  const date = formatDate(at, { locale: appLocale.value });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return t('updates.history.today', { date });
  if (at >= start.getTime() - DAY) return t('updates.history.yesterday', { date });
  return date;
}

const groups = computed(() => {
  const map = new Map<string, Task[]>();
  for (const task of props.tasks) {
    const label = dayLabel(task.finishedAt ?? task.createdAt);
    map.set(label, [...(map.get(label) ?? []), task]);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
});

function title(task: Task): string {
  const name = task.target ? displayName(task.target.kind, task.target.token) : t(`tasks.ops.${task.op}`);
  return name;
}

function meta(task: Task): string {
  const parts: string[] = [];
  if (task.fromVersion && task.toVersion) parts.push(formatVersionChange(task.fromVersion, task.toVersion));
  else if (task.toVersion) parts.push(task.toVersion);
  if (task.op !== 'upgrade') parts.push(t(`tasks.ops.${task.op}`));
  parts.push(t(`tasks.triggers.${task.trigger}`));
  if (task.startedAt && task.finishedAt)
    parts.push(formatDuration((task.finishedAt - task.startedAt) / 1000, { locale: appLocale.value }));
  return parts.join(' · ');
}

function failure(task: Task): string | null {
  if ((task.state !== 'failed' && !isDeferredUpdate(task)) || !task.error) return null;
  const key = `errors.${task.error.code}`;
  return te(key) ? t(key) : task.error.message;
}

const logOpen = ref(false);
const logTitle = ref('');
const logLines = ref<string[]>([]);

async function viewLog(task: Task) {
  logTitle.value = t('updates.log.title', { name: title(task) });
  const text = await unwrap(commands.taskLog(task.id, 2000)).catch(() => '');
  logLines.value = text ? text.split('\n') : [];
  logOpen.value = true;
}

async function retry(task: Task) {
  try {
    await queue.enqueue(task.op, task.target, 'retry', retryOptions(task));
  } catch (error) {
    toasts.push({ tone: 'danger', title: t('errors.actionFailed'), description: errorText(error) });
  }
}
</script>

<template>
  <div class="flex flex-col gap-18px">
    <section v-for="group in groups" :key="group.label">
      <h3 class="m-0 mb-8px text-13px font-500 text-ink-tertiary">{{ group.label }}</h3>
      <ul class="m-0 flex list-none flex-col gap-8px p-0">
        <li
          v-for="task in group.items"
          :key="task.id"
          class="flex items-center gap-14px rounded-big border border-solid bg-surface-card px-16px py-12px"
          :class="task.state === 'failed' ? 'border-status-danger' : 'border-line-subtle'"
        >
          <span class="w-44px shrink-0 font-mono text-12.5px text-ink-tertiary">{{
            formatTime(task.finishedAt ?? task.createdAt)
          }}</span>
          <OnAppIcon v-if="task.target" v-bind="icon(task.target.kind, task.target.token)" :size="28" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-13.5px text-ink-primary">
              <b class="font-600">{{ title(task) }}</b>
              <span class="ml-6px text-12.5px text-ink-tertiary">{{ meta(task) }}</span>
            </span>
            <span
              v-if="failure(task)"
              class="mt-2px block text-12.5px"
              :class="isDeferredUpdate(task) ? 'text-ink-secondary' : 'text-status-danger'"
              >{{ failure(task) }}</span
            >
          </span>
          <template v-if="task.state === 'failed' || isDeferredUpdate(task)">
            <OnChip v-if="isDeferredUpdate(task)">{{ t('runningApps.deferred') }}</OnChip>
            <OnButton variant="ghost" size="sm" @click="viewLog(task)">{{ t('updates.history.viewLog') }}</OnButton>
            <OnButton variant="secondary" size="sm" @click="retry(task)">{{ t('updates.history.retry') }}</OnButton>
          </template>
          <OnChip v-else-if="task.state === 'succeeded'" tone="success" icon="check">{{
            t('updates.history.succeeded')
          }}</OnChip>
          <OnChip v-else>{{ t('updates.history.canceled') }}</OnChip>
        </li>
      </ul>
    </section>
    <OnModal v-model:open="logOpen" size="lg" :title="logTitle">
      <OnLogViewer v-if="logLines.length" :lines="logLines" :height="360" :label="logTitle" />
      <p v-else class="m-0 text-13px text-ink-tertiary">{{ t('updates.log.empty') }}</p>
    </OnModal>
  </div>
</template>
