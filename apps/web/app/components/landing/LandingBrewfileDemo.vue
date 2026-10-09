<script setup lang="ts">
import { toBrewfile } from '@opennavo/shared';
import { OnIcon } from '@opennavo/ui';

// Brewfile demo (05 §7.2, 06 D-19): write items line by line, install on a new Mac with one brew bundle command.
// Step zero, complete file/success notice, is the representative frame.
const props = defineProps<{ apps: readonly LandingApp[] }>();

const DURATIONS = [3200, 700, 420, 420, 420, 700] as const;
const LINES = [4, 0, 1, 2, 3, 4] as const;

const root = ref<HTMLElement>();
const step = useDemoLoop(root, DURATIONS);

const lines = computed(() =>
  toBrewfile(props.apps.slice(0, 4).map(app => ({ kind: 'cask' as const, token: app.token })))
    .trimEnd()
    .split('\n')
);
const shown = computed(() => lines.value.slice(0, LINES[step.value] ?? lines.value.length));
const done = computed(() => step.value === 0 || step.value === DURATIONS.length - 1);
const command = 'brew bundle --file=Brewfile';
const result = computed(() => `Homebrew Bundle complete! ${lines.value.length} Brewfile dependencies now installed.`);
</script>

<template>
  <div ref="root" class="mx-auto flex max-w-300px flex-col gap-8px" inert aria-hidden="true">
    <div class="overflow-hidden rounded-default border border-solid border-line-subtle bg-surface-inset">
      <div
        class="flex items-center gap-6px border-b border-b-solid border-line-subtle px-10px py-6px text-11px text-ink-tertiary"
      >
        <OnIcon name="file-text" :size="12" />
        <span>Brewfile</span>
      </div>
      <div class="box-border flex h-98px flex-col gap-2px px-12px py-8px font-mono text-11px leading-[1.7]">
        <span
          v-for="(line, index) in shown"
          :key="`${index}-${line}`"
          class="landing-log-line block truncate text-component-mono-text"
          >{{ line }}</span
        >
      </div>
    </div>
    <div
      class="rounded-default border border-solid border-line-subtle bg-surface-inset px-12px py-8px font-mono text-11px leading-[1.7]"
    >
      <span class="block truncate text-ink-primary">$ {{ command }}</span>
      <span class="landing-bundle-result block truncate text-component-log-success" :class="done ? 'is-shown' : ''">{{
        result
      }}</span>
    </div>
  </div>
</template>

<style>
.landing-bundle-result {
  opacity: 0;
  transition: opacity var(--on-motion-duration-slow) var(--on-motion-easing-standard);
}

.landing-bundle-result.is-shown {
  opacity: 1;
}
</style>
