<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { formatMilliseconds } from '@opennavo/shared';
import { OnChip } from '@opennavo/ui';
import type { MirrorProbe } from '@/ipc/bindings';
import { useAppLocale } from '@/composables/useAppLocale';
import type { MirrorOption } from '@/composables/useMirrorOptions';

// Download source radio list (mockup 07 Settings / Sources, first-launch-onboarding §3.3): name and hostname,
// probe result, Fastest (measured), Recommended (backend setting). Presentational only; pages decide whether to save selections.
withDefaults(
  defineProps<{
    options: readonly MirrorOption[];
    probes: Readonly<Record<string, MirrorProbe>>;
    probing: boolean;
    selected?: string;
    fastest?: string;
    disabled?: boolean;
    label: string;
  }>(),
  { selected: undefined, fastest: undefined, disabled: false }
);

defineSlots<{ actions?: (props: { option: MirrorOption }) => unknown }>();

const emit = defineEmits<{ select: [option: MirrorOption] }>();

const { t } = useI18n();
const { appLocale } = useAppLocale();

function host(option: MirrorOption): string {
  const url = option.bottleDomain ?? option.probeUrl;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
</script>

<template>
  <div role="radiogroup" :aria-label="label" :aria-disabled="disabled || undefined">
    <div
      v-for="option in options"
      :key="option.key"
      class="flex items-center border-t border-t-solid border-line-subtle pr-18px first:border-t-0"
    >
      <button
        type="button"
        role="radio"
        :aria-checked="selected === option.key"
        :disabled="disabled"
        :title="option.description ?? undefined"
        class="m-0 flex min-w-0 flex-1 items-center gap-14px border-none bg-transparent px-18px py-12px text-left font-sans outline-none enabled:hover:bg-component-item-active focus-visible:shadow-focus-ring disabled:cursor-default"
        @click="emit('select', option)"
      >
        <span
          class="grid h-18px w-18px shrink-0 place-items-center rounded-full border-2 border-solid"
          :class="selected === option.key ? 'border-brand-coral' : 'border-line-default'"
          aria-hidden="true"
        >
          <span v-if="selected === option.key" class="h-8px w-8px rounded-full bg-brand-coral"></span>
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-6px text-14px font-600 text-ink-primary"
            >{{ option.name }}<OnChip v-if="option.local">{{ t('settings.customMirrors.local') }}</OnChip></span
          >
          <span class="block truncate font-mono text-12px text-ink-tertiary">{{ host(option) }}</span>
        </span>
        <span class="flex shrink-0 items-center gap-6px text-12.5px">
          <template v-if="probes[option.key]">
            <span
              v-if="probes[option.key]?.ok"
              :class="fastest === option.key ? 'text-status-success' : 'text-ink-secondary'"
            >
              {{ formatMilliseconds(probes[option.key]?.latencyMs ?? 0, { locale: appLocale }) }}
            </span>
            <span v-else class="text-status-danger">{{ t('mirrors.unavailable') }}</span>
          </template>
          <span
            v-else-if="probing"
            class="block h-12px w-12px animate-spin rounded-full border-2 border-solid border-line-default border-t-ink-secondary motion-reduce:animate-none"
            role="img"
            :aria-label="t('mirrors.probing')"
          ></span>
          <OnChip v-if="fastest === option.key" tone="success">{{ t('mirrors.fastest') }}</OnChip>
          <OnChip v-if="option.recommended" tone="outline">{{ t('mirrors.recommended') }}</OnChip>
        </span>
      </button>
      <slot name="actions" :option="option" />
    </div>
  </div>
</template>
