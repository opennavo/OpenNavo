<script setup lang="ts">
import OnEmpty from './OnEmpty.vue';
import { useUiMessages } from '../composables/locale';

export interface OnOfflineProps {
  title?: string;
  description?: string;
}

defineProps<OnOfflineProps>();

defineSlots<{ actions?: () => unknown }>();

const messages = useUiMessages();
</script>

<template>
  <div role="status">
    <OnEmpty
      icon="lucide:wifi-off"
      :title="title ?? messages.state.offlineTitle"
      :description="description ?? messages.state.offlineDescription"
    >
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </OnEmpty>
  </div>
</template>
