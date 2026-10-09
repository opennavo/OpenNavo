<script setup lang="ts">
import { formatMilliseconds } from '@opennavo/shared';
import { OnChip } from '@opennavo/ui';

// Source probe demo (06 §13 Welcome/Settings): probe then recommend lowest latency; latency numbers are illustrative.
// Step zero, probes complete, is the representative frame.
const DURATIONS = [3200, 1300] as const;
const SOURCES = [
  { key: 'official', host: 'formulae.brew.sh', latency: 186 },
  { key: 'tuna', host: 'mirrors.tuna.tsinghua.edu.cn', latency: 28 },
  { key: 'ustc', host: 'mirrors.ustc.edu.cn', latency: 41 }
] as const;

const { t, locale } = useI18n();
const formattingLocale = computed(() => toAppLocale(locale.value));
const root = ref<HTMLElement>();
const step = useDemoLoop(root, DURATIONS);
const measured = computed(() => step.value === 0);

const fastest = Math.min(...SOURCES.map(source => source.latency));
// Bars represent speed: lower latency means a longer bar.
const rows = computed(() =>
  SOURCES.map(source => ({
    ...source,
    name: t(`landing.more.mirrors.${source.key}`),
    best: source.latency === fastest,
    width: measured.value ? `${Math.round((fastest / source.latency) * 100)}%` : '0%'
  }))
);
</script>

<template>
  <div ref="root" class="mx-auto flex max-w-300px flex-col gap-12px" inert aria-hidden="true">
    <div v-for="row in rows" :key="row.key" class="flex flex-col gap-6px">
      <div class="flex items-center gap-8px">
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-12.5px font-600 text-ink-primary">{{ row.name }}</span>
          <span class="truncate font-mono text-10.5px text-ink-tertiary">{{ row.host }}</span>
        </span>
        <OnChip v-if="row.best" tone="success" class="landing-mirror-chip" :class="measured ? 'is-shown' : ''">{{
          t('landing.more.mirrors.recommended')
        }}</OnChip>
        <span
          class="w-52px shrink-0 text-right text-11.5px tabular-nums"
          :class="row.best ? 'text-status-success' : 'text-ink-secondary'"
          >{{ measured ? formatMilliseconds(row.latency, { locale: formattingLocale }) : '…' }}</span
        >
      </div>
      <span class="block h-4px overflow-hidden rounded-full bg-surface-inset">
        <span
          class="landing-mirror-bar block h-full rounded-full"
          :class="row.best ? 'bg-status-success' : 'bg-ink-disabled'"
          :style="{ width: row.width }"
        ></span>
      </span>
    </div>
  </div>
</template>

<style>
.landing-mirror-bar {
  transition: width 0.9s var(--on-motion-easing-emphasized);
}

.landing-mirror-chip {
  opacity: 0;
  transition: opacity var(--on-motion-duration-base) var(--on-motion-easing-standard) 0.6s;
}

.landing-mirror-chip.is-shown {
  opacity: 1;
}
</style>
