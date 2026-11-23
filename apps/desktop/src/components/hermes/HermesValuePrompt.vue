<script setup lang="ts">
import { ref, watch } from 'vue';
import { OnButton, OnIcon, OnModal, runOnEnter } from '@opennavo/ui';
import { useAskCountdown } from '@/composables/useAskCountdown';
import { useHermesContent } from '@/composables/useHermesContent';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** Changes when a new prompt replaces this one, so a value never carries across cards. */
    requestKey: string;
    deadline?: number | null;
    title: string;
    description?: string;
    /** A short chip naming what the value is for (env var, site, backend, …). */
    label?: string;
    /** A preformatted block above the input: the redacted sudo command, a code hint, … */
    context?: string;
    contextLabel?: string;
    masked?: boolean;
    inputMode?: 'text' | 'numeric';
    autocomplete?: string;
    placeholder?: string;
    submitLabel: string;
    skipLabel: string;
    /** `code` strips the spaces and hyphens people type in a 6-8 digit one-time code. */
    sanitize?: 'code';
  }>(),
  { masked: true, inputMode: 'text', autocomplete: 'off' }
);

const emit = defineEmits<{
  submit: [value: string];
  skip: [];
}>();

const content = useHermesContent();
const { label: remaining } = useAskCountdown(() => props.deadline);
const value = ref('');

function submit() {
  const answer = props.sanitize === 'code' ? value.value.replace(/[\s-]/g, '') : value.value;
  emit('submit', answer);
}

watch(
  () => props.requestKey,
  () => {
    value.value = '';
  },
  { immediate: true }
);
</script>

<template>
  <OnModal :open="open" :title="title" :description="description" size="sm" role="alertdialog" @close="emit('skip')">
    <div class="flex flex-col gap-10px">
      <span
        v-if="label"
        class="inline-flex w-fit items-center gap-5px rounded-full border border-solid border-line-subtle bg-surface-inset px-8px py-2px font-mono text-11px text-ink-tertiary"
      >
        <OnIcon name="lucide:key-round" :size="11" />
        {{ label }}
      </span>
      <div v-if="context" class="flex flex-col gap-6px">
        <span v-if="contextLabel" class="text-11px text-ink-tertiary">{{ contextLabel }}</span>
        <pre
          class="m-0 max-h-220px overflow-auto whitespace-pre-wrap break-words rounded-small border border-solid border-line-subtle bg-surface-inset px-10px py-8px font-mono text-11px leading-[1.5] text-ink-secondary"
          >{{ context }}</pre
        >
      </div>
      <input
        v-model="value"
        :type="masked ? 'password' : 'text'"
        :inputmode="inputMode"
        :autocomplete="autocomplete"
        spellcheck="false"
        :aria-label="title"
        :placeholder="placeholder"
        class="w-full rounded-small border border-solid border-line-default bg-surface-inset px-10px py-8px font-mono text-12px text-ink-primary outline-none focus-visible:shadow-focus-ring"
        @keydown.enter="runOnEnter($event, submit)"
      />
      <span v-if="remaining" class="text-11px tabular-nums text-ink-tertiary">
        {{ content.ask.expires.replace('{time}', remaining) }}
      </span>
    </div>
    <template #footer>
      <OnButton variant="ghost" @click="emit('skip')">{{ skipLabel }}</OnButton>
      <OnButton variant="accent" @click="submit">{{ submitLabel }}</OnButton>
    </template>
  </OnModal>
</template>
