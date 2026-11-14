<script setup lang="ts">
import { computed } from 'vue';
import { OnButton, OnIcon, OnModal } from '@opennavo/ui';
import type { OnButtonVariant } from '@opennavo/ui';
import type { HermesApprovalChoice, HermesApprovalRequest } from '@/stores/hermes';
import { useHermesContent } from '@/composables/useHermesContent';
import { useAskCountdown } from '@/composables/useAskCountdown';

const props = defineProps<{
  open: boolean;
  request: HermesApprovalRequest | null;
}>();

const emit = defineEmits<{
  decide: [choice: HermesApprovalChoice];
  close: [];
}>();

const content = useHermesContent();
const { label: remaining } = useAskCountdown(() => props.request?.deadline);

/** Footer order: the refusal first, the primary allow last (the sheet reads left to right). */
const ORDER: HermesApprovalChoice[] = ['deny', 'session', 'always', 'once'];

/**
 * The runtime decides what may be granted: `approval`'s `choices` drops `session`/`always` when the
 * command is not persistable, and a smart-approval denial reduces it to `once`/`deny`. Rendering the
 * offered set (never a fixed pair) keeps a button from answering something the backend refuses.
 */
const footer = computed<HermesApprovalChoice[]>(() => {
  const offered = props.request?.choices ?? [];
  const kept = ORDER.filter(choice => offered.includes(choice));
  return kept.length ? kept : ['deny', 'once'];
});

const VARIANT: Record<HermesApprovalChoice, OnButtonVariant> = {
  deny: 'ghost',
  session: 'secondary',
  always: 'secondary',
  once: 'accent'
};

function label(choice: HermesApprovalChoice): string {
  const copy = content.value.approval;
  if (choice === 'deny') return copy.deny;
  if (choice === 'session') return copy.allowSession;
  if (choice === 'always') return copy.always;
  return copy.allowOnce;
}
</script>

<template>
  <OnModal
    :open="open"
    :title="content.approval.title"
    :description="request?.description || content.approval.body"
    size="md"
    role="alertdialog"
    @close="emit('close')"
  >
    <div v-if="request" class="flex flex-col gap-10px">
      <span
        v-if="request.tool_name"
        class="inline-flex w-fit items-center gap-5px rounded-full border border-solid border-line-subtle bg-surface-inset px-8px py-2px text-11px text-ink-tertiary"
      >
        <OnIcon name="lucide:wrench" :size="11" />
        {{ request.tool_name }}
      </span>
      <div v-if="request.command" class="flex flex-col gap-6px">
        <span class="text-11px text-ink-tertiary">{{ content.approval.command }}</span>
        <pre
          class="m-0 max-h-220px overflow-auto whitespace-pre-wrap break-words rounded-small border border-solid border-line-subtle bg-surface-inset px-10px py-8px font-mono text-11px leading-[1.5] text-ink-secondary"
          >{{ request.command }}</pre
        >
      </div>
      <div
        v-if="request.smart_denied"
        class="flex items-start gap-8px rounded-small border border-solid border-line-subtle bg-surface-inset px-10px py-8px text-11.5px leading-[1.5] text-ink-secondary"
      >
        <OnIcon name="lucide:shield-alert" :size="13" class="mt-1px shrink-0 text-status-warning" />
        <span>{{ content.approval.smartDenied }}</span>
      </div>
      <span v-if="remaining" class="text-11px tabular-nums text-ink-tertiary">
        {{ content.ask.expires.replace('{time}', remaining) }}
      </span>
    </div>
    <template #footer>
      <OnButton
        v-for="choice in footer"
        :key="choice"
        :variant="VARIANT[choice]"
        :aria-label="label(choice)"
        @click="emit('decide', choice)"
        >{{ label(choice) }}</OnButton
      >
    </template>
  </OnModal>
</template>
