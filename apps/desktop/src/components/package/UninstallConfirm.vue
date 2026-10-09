<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { brewArgs, formatBrewCommand } from '@opennavo/shared';
import { OnButton, OnConfirm, OnIcon } from '@opennavo/ui';
import type { Kind } from '@/ipc/bindings';
import RelaunchNotice from '@/components/permissions/RelaunchNotice.vue';
import { usePackageState } from '@/composables/usePackageState';
import { useToasts } from '@/composables/useToasts';
import { usePermissionsStore } from '@/stores';

// Uninstall confirmation (06 §6.3): show complete brew command; apps may also remove data with --zap.
// Data removal touches protected directories; without Full Disk Access, Homebrew exits after moving the app (06 §12.6).
// Guide permission before confirming data removal; uncheck to uninstall only the app.
const props = defineProps<{ kind: Kind; token: string; name: string }>();
const open = defineModel<boolean>('open', { required: true });
const zap = defineModel<boolean>('zap', { required: true });
const emit = defineEmits<{ confirm: [] }>();

const { t } = useI18n();
const permissions = usePermissionsStore();
const toasts = useToasts();
const { errorText } = usePackageState();

const command = computed(() =>
  props.token
    ? formatBrewCommand(brewArgs({ op: 'uninstall', kind: props.kind, token: props.token, zap: zap.value }))
    : ''
);
// Do not block unknown detection; handle the Homebrew outcome instead.
const needsFullDisk = computed(() => props.kind === 'cask' && zap.value && permissions.fullDiskAccess === 'denied');
const guiding = computed(() => permissions.guiding === 'full_disk_access');

watch(open, value => {
  if (value) void permissions.refresh().catch(() => undefined);
});

async function enable() {
  try {
    await permissions.guide('full_disk_access');
  } catch (error) {
    toasts.push({ tone: 'danger', title: t('errors.actionFailed'), description: errorText(error) });
  }
}
</script>

<template>
  <OnConfirm
    v-model:open="open"
    tone="danger"
    :title="t('package.uninstallConfirm.title', { name })"
    :description="t('package.uninstallConfirm.description', { command })"
    :confirm-label="t('package.uninstallConfirm.confirm')"
    :confirm-disabled="needsFullDisk"
    @confirm="emit('confirm')"
  >
    <label v-if="kind === 'cask'" class="mt-12px flex items-center gap-8px text-13px text-ink-secondary">
      <input v-model="zap" type="checkbox" class="m-0 h-14px w-14px accent-brand-coral" />
      {{ t('package.uninstallConfirm.zap') }}
    </label>
    <div
      v-if="needsFullDisk"
      class="mt-10px flex items-center gap-10px rounded-default bg-surface-card-alt px-12px py-10px"
      role="status"
    >
      <OnIcon name="hard-drive" :size="16" class="shrink-0 text-ink-secondary" />
      <span class="min-w-0 flex-1">
        <span class="block text-13px font-600 text-ink-primary">{{ t('permission.uninstall.title') }}</span>
        <span class="mt-2px block text-12px leading-[1.5] text-ink-tertiary">{{ t('permission.uninstall.body') }}</span>
      </span>
      <OnButton variant="secondary" size="xs" class="shrink-0" :loading="guiding" @click="enable">{{
        guiding ? t('permission.prompt.waiting') : t('permission.prompt.enable')
      }}</OnButton>
    </div>
    <RelaunchNotice v-if="needsFullDisk && permissions.relaunchRequired" class="mt-8px" />
  </OnConfirm>
</template>
