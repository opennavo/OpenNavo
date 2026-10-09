<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatMilliseconds } from '@opennavo/shared';
import { OnButton, OnChip } from '@opennavo/ui';
import type { MirrorProbe } from '@/ipc/bindings';
import { useAppLocale } from '@/composables/useAppLocale';
import type { MirrorOption } from '@/composables/useMirrorOptions';

// Welcome sources (mockup 07, owner revision 2026-10-07): official left, fastest other mirror right.
// Recommend only the lowest-latency card. Presentational only; pages own selection and persistence.
const props = defineProps<{
  official: MirrorOption;
  /** Fastest available mirror; first backend-ordered mirror before probes finish. */
  mirror?: MirrorOption;
  probes: Readonly<Record<string, MirrorProbe>>;
  probing: boolean;
  selected?: string;
  /** Lowest-latency option including official; only this option is recommended. */
  recommended?: string;
  /** Mirror list unavailable. */
  configFailed: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ select: [option: MirrorOption]; retry: [] }>();

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

type Latency = 'pending' | 'failed' | 'none' | { text: string };

function latency(option: MirrorOption | undefined): Latency {
  if (!option) return 'none';
  const result = props.probes[option.key];
  if (!result) return props.probing ? 'pending' : 'none';
  if (!result.ok || result.latencyMs === null) return 'failed';
  return { text: formatMilliseconds(result.latencyMs, { locale: appLocale.value }) };
}

const cards = computed(() =>
  [
    { key: 'official', title: t('welcome.source.official'), option: props.official, detail: host(props.official) },
    {
      key: 'mirror',
      title: t('welcome.source.mirror'),
      option: props.mirror,
      detail: props.mirror?.name ?? (props.configFailed ? t('welcome.source.mirrorMissing') : '')
    }
  ].map(card => ({
    ...card,
    latency: latency(card.option),
    checked: Boolean(card.option) && props.selected === card.option?.key,
    recommended: Boolean(card.option) && props.recommended === card.option?.key
  }))
);
</script>

<template>
  <div class="grid grid-cols-2 gap-10px" role="radiogroup" :aria-label="t('welcome.source.title')">
    <button
      v-for="card in cards"
      :key="card.key"
      type="button"
      role="radio"
      :aria-checked="card.checked"
      :disabled="disabled || !card.option"
      class="m-0 flex min-h-76px min-w-0 flex-col justify-between gap-6px rounded-big border border-solid px-16px py-13px text-left font-sans outline-none transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring disabled:cursor-default"
      :class="
        card.checked
          ? 'border-brand-coral bg-accent-coral-subtle'
          : 'border-line-default bg-transparent enabled:hover:border-line-strong enabled:hover:bg-component-card-hover disabled:opacity-60'
      "
      @click="card.option && emit('select', card.option)"
    >
      <span class="flex w-full items-center gap-8px">
        <span class="min-w-0 flex-1 truncate text-14px font-600 text-ink-primary">{{ card.title }}</span>
        <OnChip v-if="card.recommended" tone="success">{{ t('mirrors.recommended') }}</OnChip>
      </span>
      <span class="flex w-full items-center gap-8px text-12.5px">
        <span class="min-w-0 flex-1 truncate text-ink-tertiary">{{ card.detail }}</span>
        <span
          v-if="card.latency === 'pending'"
          class="block h-11px w-11px shrink-0 animate-spin rounded-full border-2 border-solid border-line-default border-t-ink-secondary motion-reduce:animate-none"
          role="img"
          :aria-label="t('mirrors.probing')"
        ></span>
        <span v-else-if="card.latency === 'failed'" class="shrink-0 text-status-danger">{{
          t('mirrors.unavailable')
        }}</span>
        <span
          v-else-if="typeof card.latency === 'object'"
          class="shrink-0 tabular-nums"
          :class="card.recommended ? 'text-status-success' : 'text-ink-secondary'"
          >{{ card.latency.text }}</span
        >
      </span>
    </button>
  </div>
  <p v-if="configFailed" class="m-0 mt-8px flex items-center gap-8px text-12.5px text-ink-tertiary" role="status">
    <span class="min-w-0 flex-1">{{ t('mirrors.configFailed') }}</span>
    <OnButton variant="ghost" size="xs" @click="emit('retry')">{{ t('welcome.source.retry') }}</OnButton>
  </p>
</template>
