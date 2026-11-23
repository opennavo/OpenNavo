<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { OnButton, OnModal, runOnEnter } from '@opennavo/ui';
import { useAskCountdown } from '@/composables/useAskCountdown';
import { useHermesContent } from '@/composables/useHermesContent';

const props = defineProps<{
  open: boolean;
  /** Changes when a new prompt replaces this one, so values never carry across cards. */
  requestKey: string;
  deadline?: number | null;
  title: string;
  description?: string;
  identifierLabel: string;
  identifierPlaceholder?: string;
  passwordLabel: string;
  submitLabel: string;
  declineLabel: string;
}>();

const emit = defineEmits<{
  save: [identifier: string, password: string];
  decline: [];
}>();

const content = useHermesContent();
const { label: remaining } = useAskCountdown(() => props.deadline);
const identifier = ref('');
const password = ref('');
const canSave = computed(() => Boolean(identifier.value.trim()) && Boolean(password.value));

function save() {
  if (!canSave.value) return;
  emit('save', identifier.value, password.value);
}

watch(
  () => props.requestKey,
  () => {
    identifier.value = '';
    password.value = '';
  },
  { immediate: true }
);
</script>

<template>
  <OnModal :open="open" :title="title" :description="description" size="sm" role="alertdialog" @close="emit('decline')">
    <div class="flex flex-col gap-10px">
      <label class="flex flex-col gap-5px">
        <span class="text-11px text-ink-tertiary">{{ identifierLabel }}</span>
        <input
          v-model="identifier"
          type="text"
          autocomplete="username"
          spellcheck="false"
          :aria-label="identifierLabel"
          :placeholder="identifierPlaceholder"
          class="w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px py-8px text-12px text-ink-primary outline-none focus-visible:shadow-focus-ring"
        />
      </label>
      <label class="flex flex-col gap-5px">
        <span class="text-11px text-ink-tertiary">{{ passwordLabel }}</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          :aria-label="passwordLabel"
          class="w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px py-8px text-12px text-ink-primary outline-none focus-visible:shadow-focus-ring"
          @keydown.enter="runOnEnter($event, save)"
        />
      </label>
      <span v-if="remaining" class="text-11px tabular-nums text-ink-tertiary">
        {{ content.ask.expires.replace('{time}', remaining) }}
      </span>
    </div>
    <template #footer>
      <OnButton variant="ghost" @click="emit('decline')">{{ declineLabel }}</OnButton>
      <OnButton variant="accent" :disabled="!canSave" @click="save">{{ submitLabel }}</OnButton>
    </template>
  </OnModal>
</template>
