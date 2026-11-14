<script setup lang="ts">
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { OnToastRegion } from '@opennavo/ui';
import HermesMark from '@/components/hermes/HermesMark.vue';
import { useToasts } from '@/composables/useToasts';

const toasts = useToasts();
const profile = computed(() => new URLSearchParams(window.location.search).get('profile')?.trim() || 'default');
</script>

<template>
  <div class="flex h-screen min-h-0 flex-col overflow-hidden bg-surface-base text-ink-primary">
    <header
      class="flex h-52px shrink-0 items-center gap-9px border-b border-b-solid border-line-subtle px-18px"
      data-tauri-drag-region
    >
      <HermesMark :size="22" />
      <span class="text-13px font-600 text-ink-primary">Hermes</span>
      <span class="rounded-tiny bg-surface-raised px-7px py-2px text-11px text-ink-secondary">{{ profile }}</span>
      <div class="flex-1 self-stretch" data-tauri-drag-region></div>
    </header>
    <main class="min-h-0 flex-1 overflow-y-auto px-28px pb-28px pt-6px">
      <RouterView />
    </main>
    <OnToastRegion :items="toasts.items.value" @dismiss="toasts.dismiss" @action="toasts.runAction" />
  </div>
</template>
