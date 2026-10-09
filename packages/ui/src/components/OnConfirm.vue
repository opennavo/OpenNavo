<script setup lang="ts">
import OnButton from './OnButton.vue';
import OnModal from './OnModal.vue';
import { useUiMessages } from '../composables/locale';

export interface OnConfirmProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: red destructive button, no Escape/backdrop dismissal, Cancel focused initially. */
  tone?: 'primary' | 'danger';
  /** Execution after confirmation: show spinner on Confirm. */
  loading?: boolean;
  /** Disable confirmation until prerequisites, such as system permissions, are met. */
  confirmDisabled?: boolean;
}

const props = withDefaults(defineProps<OnConfirmProps>(), { tone: 'primary' });

const emit = defineEmits<{
  'update:open': [open: boolean];
  /** Confirm click; host executes and closes. */
  confirm: [];
  cancel: [];
}>();

defineSlots<{ default?: () => unknown }>();

const messages = useUiMessages();

function cancel() {
  emit('update:open', false);
  emit('cancel');
}
</script>

<template>
  <OnModal
    :open="open"
    :title="title"
    :description="description"
    size="sm"
    role="alertdialog"
    :dismissible="props.tone !== 'danger'"
    :closable="false"
    :initial-focus="props.tone === 'danger' ? '[data-on-cancel]' : '[data-on-confirm]'"
    @close="cancel"
  >
    <template v-if="$slots.default" #default>
      <slot />
    </template>
    <template #footer>
      <OnButton variant="ghost" data-on-cancel :disabled="loading" @click="cancel">
        {{ cancelLabel ?? messages.dialog.cancel }}
      </OnButton>
      <OnButton
        :variant="props.tone === 'danger' ? 'danger' : 'primary'"
        data-on-confirm
        :loading="loading"
        :disabled="confirmDisabled"
        @click="emit('confirm')"
      >
        {{ confirmLabel ?? messages.dialog.confirm }}
      </OnButton>
    </template>
  </OnModal>
</template>
