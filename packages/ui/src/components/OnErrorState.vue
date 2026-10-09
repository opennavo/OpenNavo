<script setup lang="ts">
import OnButton from './OnButton.vue';
import OnEmpty from './OnEmpty.vue';
import { useUiMessages } from '../composables/locale';

export interface OnErrorStateProps {
  title?: string;
  description?: string;
  /** Show request ID for issue reports (04 §1). */
  requestId?: string | null;
  /** Show Retry button. */
  retryable?: boolean;
}

withDefaults(defineProps<OnErrorStateProps>(), { retryable: true });

const emit = defineEmits<{ retry: [] }>();

const messages = useUiMessages();
</script>

<template>
  <div role="alert">
    <OnEmpty
      icon="lucide:circle-alert"
      :title="title ?? messages.state.loadFailedTitle"
      :description="description ?? messages.state.loadFailedDescription"
    >
      <template v-if="retryable || requestId" #actions>
        <OnButton v-if="retryable" variant="secondary" icon="lucide:refresh-cw" @click="emit('retry')">{{
          messages.action.retry
        }}</OnButton>
        <span v-if="requestId" class="w-full font-mono text-11px text-ink-tertiary">{{ requestId }}</span>
      </template>
    </OnEmpty>
  </div>
</template>
