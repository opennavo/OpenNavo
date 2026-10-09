import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { EnvInfo } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';

/** Local environment (06 §6.1): Homebrew path/version and App Management permission; replace on env:changed. */
export const useEnvStore = defineStore('env', () => {
  const info = ref<EnvInfo | null>(null);
  const detecting = ref(false);
  const hasBrew = computed(() => Boolean(info.value?.brew));

  async function detect() {
    detecting.value = true;
    try {
      info.value = await unwrap(commands.envDetect());
    } finally {
      detecting.value = false;
    }
  }

  return { info, detecting, hasBrew, detect };
});
