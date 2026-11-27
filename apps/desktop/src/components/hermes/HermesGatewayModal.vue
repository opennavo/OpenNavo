<script setup lang="ts">
import { ref, watch } from 'vue';
import { OnButton, OnIcon, OnModal } from '@opennavo/ui';
import { useHermesStore } from '@/stores/hermes';
import { useHermesContent } from '@/composables/useHermesContent';
import { IpcError } from '@/ipc/client';
import { validatePanelBaseUrl } from '@/hermes/panelUrl';

const props = defineProps<{
  open: boolean;
  reloginId?: string | null;
  initialName?: string;
  initialUrl?: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useHermesStore();
const content = useHermesContent();

const name = ref('');
const url = ref('');
const username = ref('');
const password = ref('');
const saving = ref(false);
const error = ref('');
/** Bumped on every open; a submit that was in flight for an older form must not close this one. */
let formSeq = 0;

watch(
  () => props.open,
  open => {
    if (!open) return;
    formSeq += 1;
    // A reopened form is a new submission even if the old login is still running.
    saving.value = false;
    name.value = props.reloginId ? (props.initialName ?? '') : '';
    url.value = props.reloginId ? (props.initialUrl ?? '') : '';
    username.value = '';
    password.value = '';
    error.value = '';
  }
);

function validate(): string {
  if (!name.value.trim() || !url.value.trim() || !username.value.trim() || !password.value) {
    return content.value.profiles.required;
  }
  switch (validatePanelBaseUrl(url.value)) {
    case 'invalid':
      return content.value.profiles.invalidUrl;
    case 'insecure':
      return content.value.profiles.panelInsecure;
    default:
      return '';
  }
}
async function save() {
  // A double submit while the first login is in flight would create a second panel session.
  if (saving.value) return;
  error.value = validate();
  if (error.value) return;
  const request = ++formSeq;
  saving.value = true;
  try {
    if (props.reloginId) {
      await store.reloginPanel(props.reloginId, url.value, username.value, password.value);
    } else {
      await store.addPanelProfile(name.value, url.value, username.value, password.value);
    }
    // The modal was closed/reopened for another connection while this login ran: its receipt
    // must not close the form now on screen.
    if (request !== formSeq || !props.open) return;
    emit('saved');
    emit('close');
  } catch (cause) {
    if (request === formSeq && props.open) {
      error.value = cause instanceof IpcError ? (cause.detail ?? cause.message) : String(cause);
    }
  } finally {
    if (request === formSeq) saving.value = false;
  }
}
</script>

<template>
  <OnModal
    :open="props.open"
    :title="content.profiles.addTitle"
    :description="content.profiles.panelBody"
    size="md"
    role="dialog"
    @close="emit('close')"
  >
    <form class="flex flex-col gap-12px" @submit.prevent="save">
      <label class="flex flex-col gap-5px">
        <span class="text-10.5px font-500 text-ink-secondary">{{ content.profiles.name }}</span>
        <input
          v-model="name"
          class="h-34px w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px font-sans text-11.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
          :placeholder="content.profiles.namePlaceholder"
          autocomplete="off"
        />
      </label>
      <label class="flex flex-col gap-5px">
        <span class="text-10.5px font-500 text-ink-secondary">{{ content.profiles.panelUrl }}</span>
        <input
          v-model="url"
          class="h-34px w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px font-mono text-10.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
          placeholder="http://panel.tail1234.ts.net:9119"
          autocomplete="off"
        />
        <span class="text-10px leading-[1.5] text-ink-tertiary">{{ content.profiles.panelUrlHint }}</span>
        <span v-if="url.trim().startsWith('http://')" class="text-10px leading-[1.5] text-status-warning">{{
          content.profiles.panelHttpHint
        }}</span>
      </label>
      <label class="flex flex-col gap-5px">
        <span class="text-10.5px font-500 text-ink-secondary">{{ content.profiles.panelUsername }}</span>
        <input
          v-model="username"
          class="h-34px w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px font-sans text-11.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
          autocomplete="username"
        />
      </label>
      <label class="flex flex-col gap-5px">
        <span class="text-10.5px font-500 text-ink-secondary">{{ content.profiles.panelPassword }}</span>
        <input
          v-model="password"
          type="password"
          class="h-34px w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px font-sans text-11.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
          autocomplete="current-password"
        />
      </label>
      <div
        class="flex items-start gap-8px rounded-small border border-solid border-[rgba(145,135,255,0.14)] bg-[rgba(145,135,255,0.045)] p-9px text-10px leading-[1.55] text-[#b7b1df]"
      >
        <OnIcon name="lucide:shield" :size="13" class="mt-1px shrink-0" />{{ content.profiles.tokenHint }}
      </div>
      <p v-if="error" class="m-0 text-10.5px leading-[1.5] text-status-danger">{{ error }}</p>
    </form>
    <template #footer>
      <OnButton variant="ghost" :disabled="saving" @click="emit('close')">{{ content.common.cancel }}</OnButton>
      <OnButton variant="accent" :disabled="saving" icon="lucide:check" @click="save">{{
        saving ? content.profiles.saving : content.profiles.panelLogin
      }}</OnButton>
    </template>
  </OnModal>
</template>
