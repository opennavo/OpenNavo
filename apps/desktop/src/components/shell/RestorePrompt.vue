<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OnButton, OnModal } from '@opennavo/ui';
import type { Task } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';
import { useTasksStore } from '@/stores';

// Startup recovery (06 §4.3 item 5): offer Continue / Discard for previously queued tasks; Continue re-enqueues the original task (Rust returns the same task).
// Discard cancels each task. Include only pre-startup tasks, not catch-up schedules; require an explicit choice, never treat Escape/backdrop as discard.
const { t } = useI18n();
const tasks = useTasksStore();
const startedAt = performance.timeOrigin;

const restored = ref<Task[]>(tasks.queued.filter(task => task.createdAt < startedAt));
const open = ref(restored.value.length > 0);
const working = ref(false);
const count = computed(() => restored.value.length);

async function resume() {
  working.value = true;
  try {
    for (const task of restored.value) {
      await unwrap(commands.taskEnqueue(task.op, task.target, task.options, task.trigger));
    }
  } finally {
    working.value = false;
    open.value = false;
  }
}

async function discard() {
  for (const task of restored.value) await unwrap(commands.taskCancel(task.id)).catch(() => undefined);
  open.value = false;
}
</script>

<template>
  <OnModal
    :open="open"
    :title="t('restore.title', { n: count }, { plural: count })"
    :description="t('restore.description')"
    size="sm"
    role="alertdialog"
    :dismissible="false"
    :closable="false"
    initial-focus="[data-restore-resume]"
  >
    <template #footer>
      <OnButton variant="ghost" :disabled="working" @click="discard">{{ t('restore.discard') }}</OnButton>
      <OnButton variant="primary" data-restore-resume :loading="working" @click="resume">
        {{ t('restore.resume') }}
      </OnButton>
    </template>
  </OnModal>
</template>
