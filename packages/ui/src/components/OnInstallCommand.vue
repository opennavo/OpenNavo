<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import OnIcon from './OnIcon.vue';
import { useUiMessages } from '../composables/locale';
import { commandLines } from '../utils/command';

export interface OnInstallCommandProps {
  command: string;
  /** Title defaults to Install command; desktop clarifies this is the command OpenNavo executes. */
  title?: string;
  /** Wrap after --cask/--formula beyond this length. */
  wrapAt?: number;
  /** Copy implementation, browser clipboard by default; desktop may supply a plugin. */
  copy?: (text: string) => Promise<void>;
}

const props = withDefaults(defineProps<OnInstallCommandProps>(), { wrapAt: 30 });

const emit = defineEmits<{ copied: [command: string]; copyFailed: [error: unknown] }>();

const messages = useUiMessages();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const lines = computed(() => commandLines(props.command, props.wrapAt));

async function copyCommand() {
  const write = props.copy ?? ((text: string) => navigator.clipboard.writeText(text));
  try {
    await write(props.command);
    copied.value = true;
    emit('copied', props.command);
    clearTimeout(timer);
    // After copying, show Copied for 1.5 seconds (08 §8.19).
    timer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch (error) {
    emit('copyFailed', error);
  }
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="flex flex-col gap-10px">
    <div class="flex items-center justify-between gap-12px">
      <span class="text-11.5px text-ink-tertiary">{{ title ?? messages.installCommand.title }}</span>
      <button
        type="button"
        class="m-0 inline-flex items-center gap-4px rounded-tiny border-none bg-transparent p-0 font-sans text-12px text-ink-secondary outline-none transition-colors duration-fast hover:text-ink-primary focus-visible:shadow-focus-ring"
        @click="copyCommand"
      >
        <OnIcon :name="copied ? 'lucide:check' : 'lucide:copy'" :size="13" />
        <span aria-live="polite">{{ copied ? messages.action.copied : messages.action.copy }}</span>
      </button>
    </div>
    <pre
      class="m-0 overflow-x-auto rounded-default border border-solid border-line-subtle bg-surface-inset px-14px py-12px font-mono text-11.5px leading-[1.6] text-ink-primary"
    ><code><span v-for="(line, index) in lines" :key="index" class="block whitespace-pre"><span class="select-none" :class="index === 0 ? 'text-brand-salmon' : ''">{{ index === 0 ? '$ ' : '  ' }}</span>{{ line }}</span></code></pre>
  </div>
</template>
