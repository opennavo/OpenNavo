import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { InstallPreflight } from '@/ipc/bindings';

/** Each install needs separate consent; closing, canceling, or unmounting confirmation never authorizes adoption. */
export const useInstallConfirmStore = defineStore('install-confirm', () => {
  const pending = ref<InstallPreflight | null>(null);
  let resolve: ((confirmed: boolean) => void) | undefined;
  function ask(check: InstallPreflight): Promise<boolean> {
    pending.value = check;
    return new Promise(done => {
      resolve = done;
    });
  }
  function choose(confirmed: boolean) {
    const allowed = confirmed && pending.value?.status === 'conflict';
    const done = resolve;
    resolve = undefined;
    pending.value = null;
    done?.(allowed);
  }
  return { pending, ask, choose };
});
