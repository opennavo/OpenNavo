<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { OnButton, OnIcon, OnModal } from '@opennavo/ui';
import type { OnButtonVariant } from '@opennavo/ui';
import type { HermesApprovalChoice, HermesApprovalRequest } from '@/stores/hermes';
import { useHermesContent } from '@/composables/useHermesContent';
import { useAskCountdown } from '@/composables/useAskCountdown';

const props = withDefaults(
  defineProps<{
    open: boolean;
    request: HermesApprovalRequest | null;
    /** Approvals still waiting in this conversation; `> 1` shows the queue position. */
    total?: number;
  }>(),
  { total: 1 }
);

const emit = defineEmits<{
  decide: [choice: HermesApprovalChoice];
  close: [];
}>();

const content = useHermesContent();
const { label: remaining } = useAskCountdown(() => props.request?.deadline);
const confirmAlways = ref(false);

/** Footer order: the refusal first, the primary allow last (the sheet reads left to right). */
const ORDER: HermesApprovalChoice[] = ['deny', 'session', 'always', 'once'];

/**
 * The runtime decides what may be granted: `approval`'s `choices` drops `session`/`always` when the
 * command is not persistable, and a smart-approval denial reduces it to `once`/`deny`. When the
 * runtime omits `choices`, derive the same default set from `allow_session` / `allow_permanent`.
 * Rendering the offered set (never a fixed pair) keeps a button from answering something the
 * backend refuses.
 */
const footer = computed<HermesApprovalChoice[]>(() => {
  const request = props.request;
  if (!request) return ['deny', 'once'];
  const offered = request.choices?.length
    ? new Set<string>(request.choices)
    : (() => {
        const derived = new Set<string>(['deny', 'once']);
        if (!request.smart_denied) {
          if (request.allow_session !== false) derived.add('session');
          if (request.allow_permanent !== false) derived.add('always');
        }
        return derived;
      })();
  const kept = ORDER.filter(choice => offered.has(choice));
  return kept.length ? kept : ['deny', 'once'];
});

const queueLabel = computed(() =>
  content.value.approval.queue.replace('{position}', '1').replace('{total}', String(props.total))
);

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

/** "Always" writes a permanent rule, so it goes through a confirmation step first. */
function decide(choice: HermesApprovalChoice) {
  if (choice === 'always') {
    confirmAlways.value = true;
    return;
  }
  emit('decide', choice);
}

function confirmAlwaysAllow() {
  confirmAlways.value = false;
  emit('decide', 'always');
}

watch(
  () => props.request?.requestId,
  () => {
    confirmAlways.value = false;
  }
);
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
      <div class="flex items-center gap-6px">
        <span
          v-if="request.tool_name"
          class="inline-flex w-fit items-center gap-5px rounded-full border border-solid border-line-subtle bg-surface-inset px-8px py-2px text-11px text-ink-tertiary"
        >
          <OnIcon name="lucide:wrench" :size="11" />
          {{ request.tool_name }}
        </span>
        <span v-if="total > 1" class="ml-auto text-11px tabular-nums text-ink-tertiary">{{ queueLabel }}</span>
      </div>
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
        @click="decide(choice)"
        >{{ label(choice) }}</OnButton
      >
    </template>
  </OnModal>

  <OnModal
    :open="confirmAlways"
    :title="content.approval.alwaysConfirmTitle"
    :description="content.approval.alwaysConfirmBody"
    size="sm"
    role="alertdialog"
    @close="confirmAlways = false"
  >
    <pre
      v-if="request?.command"
      class="m-0 max-h-160px overflow-auto whitespace-pre-wrap break-words rounded-small border border-solid border-line-subtle bg-surface-inset px-10px py-8px font-mono text-11px leading-[1.5] text-ink-secondary"
      >{{ request.command }}</pre
    >
    <template #footer>
      <OnButton variant="ghost" @click="confirmAlways = false">{{ content.approval.alwaysCancel }}</OnButton>
      <OnButton variant="accent" @click="confirmAlwaysAllow">{{ content.approval.alwaysConfirm }}</OnButton>
    </template>
  </OnModal>
</template>
