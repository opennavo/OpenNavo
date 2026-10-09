import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { RunningApp, Task } from '@/ipc/bindings';

export const isDeferredUpdate = (task: Task) =>
  task.state === 'canceled' &&
  ['E_APP_RUNNING', 'E_APP_QUIT_FAILED', 'E_APP_CHECK_FAILED'].includes(task.error?.code ?? '');

export type UpdateChoice = { action: 'cancel' | 'skip' | 'quit'; reopen: boolean };

/** Consent covers only the listed targets; Rust checks again before queue execution. */
export const useRunningAppsStore = defineStore('running-apps', () => {
  const pending = ref<{ apps: RunningApp[]; batch: boolean } | null>(null);
  let resolve: ((choice: UpdateChoice) => void) | undefined;
  function ask(apps: RunningApp[], batch: boolean): Promise<UpdateChoice> {
    pending.value = { apps, batch };
    return new Promise<UpdateChoice>(done => {
      resolve = done;
    });
  }
  function choose(action: UpdateChoice['action'], reopen = false) {
    const done = resolve;
    resolve = undefined;
    pending.value = null;
    done?.({ action, reopen });
  }
  return { pending, ask, choose };
});
