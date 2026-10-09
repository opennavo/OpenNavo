<script setup lang="ts">
import { OnButton, OnModal } from '@opennavo/ui';

// Missing-client dialog (05 §7.1) appears if the page does not blur after deep-link navigation.
const { t } = useI18n();
const localePath = useLocalePath();
const { prompt, skipPrompt } = useOpenInApp();
const { copy } = useCopyCommand();
const NuxtLink = resolveComponent('NuxtLink');

const open = computed({
  get: () => prompt.value !== null,
  set: value => {
    if (!value) prompt.value = null;
  }
});

function copyInstead() {
  const target = prompt.value;
  prompt.value = null;
  if (target) void copy(target.kind, target.token);
}

function dontAsk() {
  skipPrompt();
  copyInstead();
}
</script>

<template>
  <OnModal
    v-model:open="open"
    size="sm"
    :title="t('openInApp.title')"
    :description="t('openInApp.body', { name: prompt?.name ?? '' })"
  >
    <template #footer>
      <OnButton variant="ghost" @click="dontAsk">{{ t('openInApp.dontAsk') }}</OnButton>
      <OnButton @click="copyInstead">{{ t('openInApp.copyInstead') }}</OnButton>
      <OnButton variant="primary" :href="localePath('/download')" :link-as="NuxtLink" @click="prompt = null">
        {{ t('openInApp.download') }}
      </OnButton>
    </template>
  </OnModal>
</template>
