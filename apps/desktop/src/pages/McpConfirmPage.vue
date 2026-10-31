<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { OnButton, OnLogo } from '@opennavo/ui';
import type { McpConfirmView } from '@/ipc/bindings';
import { commands } from '@/ipc/client';

// Local MCP confirmation, in the window Rust creates for one write request. Everything shown comes from Rust as plain
// text (already filtered for display) and is rendered with text interpolation only. Deny is the default: Return,
// Escape and closing the window all deny. Allow only counts as a click, and Rust refuses it for about a second after
// this page first reads the request, whatever this page shows.
const { t } = useI18n();
const view = ref<McpConfirmView | null>(null);
const armed = ref(false);
const answering = ref(false);
const failure = ref<'expired' | 'failed' | null>(null);
const denyButton = ref<{ $el?: HTMLElement } | null>(null);
let arming: ReturnType<typeof setTimeout> | undefined;

function arm(afterMs: number) {
  armed.value = false;
  clearTimeout(arming);
  arming = setTimeout(() => (armed.value = true), afterMs);
}

async function load() {
  const result = await commands.mcpConfirmGet().catch(() => null);
  view.value = result?.status === 'ok' ? result.data : null;
  if (!view.value) {
    failure.value = 'expired';
    return;
  }
  arm(view.value.allowAfterMs);
  await nextTick();
  denyButton.value?.$el?.focus();
}

async function answer(allow: boolean) {
  if (!view.value || answering.value || (allow && !armed.value)) return;
  answering.value = true;
  failure.value = null;
  try {
    const result = await commands.mcpConfirmAnswer(view.value.id, allow);
    if (result.status === 'ok') return;
    if (result.error.code === 'E_CONFIRMATION_TOO_EARLY') arm(300);
    else failure.value = result.error.code === 'E_CONFIRMATION_EXPIRED' ? 'expired' : 'failed';
  } catch {
    failure.value = 'failed';
  } finally {
    answering.value = false;
  }
}

// Return and Escape never approve, wherever the focus is.
function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    void answer(false);
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  void load();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  clearTimeout(arming);
});

const caller = computed(() => {
  const current = view.value;
  if (!current) return '';
  if (current.signer) return current.signer;
  if (current.callerPath) return t('mcpConfirm.unsigned', { path: current.callerPath });
  return t('mcpConfirm.unknownCaller');
});
const isInstall = computed(() => view.value?.action === 'install');
</script>

<template>
  <main class="box-border flex h-screen flex-col bg-surface-canvas px-24px pb-20px pt-22px font-sans text-ink-primary">
    <template v-if="view">
      <header class="flex items-center gap-12px">
        <OnLogo :size="30" />
        <div class="min-w-0">
          <h1 class="m-0 text-16px font-650 leading-[1.3]">{{ t('mcpConfirm.title') }}</h1>
          <p class="m-0 mt-2px text-12.5px text-ink-secondary">
            {{ isInstall ? t('mcpConfirm.introInstall') : t('mcpConfirm.introUninstall') }}
          </p>
        </div>
      </header>

      <section
        class="mt-16px rounded-default border border-solid border-line-subtle bg-surface-raised px-16px py-14px"
        data-test="mcp-confirm-request"
      >
        <div class="flex items-baseline justify-between gap-12px">
          <span class="text-15px font-650">{{ view.name }}</span>
          <span class="shrink-0 rounded-full bg-surface-inset px-8px py-2px text-11.5px font-600 text-ink-secondary">{{
            isInstall ? t('mcpConfirm.install') : t('mcpConfirm.uninstall')
          }}</span>
        </div>
        <dl class="m-0 mt-10px grid grid-cols-[96px_minmax(0,1fr)] gap-x-10px gap-y-6px text-12.5px">
          <template v-if="isInstall">
            <dt class="text-ink-tertiary">{{ t('mcpConfirm.target') }}</dt>
            <dd class="m-0 min-w-0 break-all font-mono text-12px text-ink-secondary">{{ view.target }}</dd>
          </template>
          <template v-if="view.path">
            <dt class="text-ink-tertiary">{{ t('mcpConfirm.path') }}</dt>
            <dd class="m-0 min-w-0 break-all font-mono text-12px text-ink-secondary">{{ view.path }}</dd>
          </template>
          <dt class="text-ink-tertiary">{{ t('mcpConfirm.requestedBy') }}</dt>
          <dd class="m-0 min-w-0 break-all text-ink-primary" data-test="mcp-confirm-caller">{{ caller }}</dd>
          <template v-if="view.signer && view.callerPath">
            <dt class="sr-only">{{ t('mcpConfirm.path') }}</dt>
            <dd class="m-0 min-w-0 break-all font-mono text-11.5px text-ink-tertiary col-start-2">
              {{ view.callerPath }}
            </dd>
          </template>
          <template v-if="view.mayComeFrom">
            <dt class="text-ink-tertiary">{{ t('mcpConfirm.mayComeFrom') }}</dt>
            <dd class="m-0 min-w-0 break-all text-ink-secondary" data-test="mcp-confirm-origin">
              {{ t('mcpConfirm.unverified', { name: view.mayComeFrom }) }}
            </dd>
          </template>
          <template v-if="view.claimedName">
            <dt class="text-ink-tertiary">{{ t('mcpConfirm.claims') }}</dt>
            <dd class="m-0 min-w-0 break-all text-ink-secondary" data-test="mcp-confirm-claims">
              {{ view.claimedName }}
            </dd>
          </template>
        </dl>
      </section>

      <p class="m-0 mt-14px text-12.5px font-600 text-ink-primary" data-test="mcp-confirm-footer">
        {{ t('mcpConfirm.footer') }}
      </p>
      <p v-if="failure" role="alert" class="m-0 mt-8px text-12px text-status-danger">
        {{ t(`mcpConfirm.${failure}`) }}
      </p>

      <footer class="mt-auto flex justify-end gap-8px pt-16px">
        <OnButton :disabled="!armed || answering" data-test="mcp-confirm-allow" @click="answer(true)">{{
          t('mcpConfirm.allow')
        }}</OnButton>
        <OnButton
          ref="denyButton"
          variant="primary"
          :disabled="answering"
          data-test="mcp-confirm-deny"
          @click="answer(false)"
          >{{ t('mcpConfirm.deny') }}</OnButton
        >
      </footer>
    </template>
    <p v-else-if="failure" class="m-0 my-auto text-center text-12.5px text-ink-tertiary" data-test="mcp-confirm-none">
      {{ t('mcpConfirm.expired') }}
    </p>
  </main>
</template>
