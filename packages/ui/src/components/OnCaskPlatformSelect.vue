<script setup lang="ts">
import { computed } from 'vue';
import type { CaskPlatform } from '@opennavo/api';
import { useUiMessages } from '../composables/locale';

const props = defineProps<{ platforms: readonly CaskPlatform[]; modelValue?: string }>();
const emit = defineEmits<{ 'update:modelValue': [tag: string] }>();
const messages = useUiMessages();
const selected = computed(
  () => props.platforms.find(platform => platform.tag === props.modelValue) ?? props.platforms[0]
);
const requirements = computed(() =>
  selected.value
    ? [
        {
          label: messages.value.cask.requirements,
          value: selected.value.dependsOn.macos ?? messages.value.cask.unknown
        },
        { label: messages.value.cask.formulae, value: selected.value.dependsOn.formulae.join(' · ') },
        { label: messages.value.cask.casks, value: selected.value.dependsOn.casks.join(' · ') }
      ].filter(item => item.value)
    : []
);

function onSelect(event: Event) {
  const target = event.target;
  if (target instanceof HTMLSelectElement) emit('update:modelValue', target.value);
}

function label(platform: CaskPlatform) {
  return `macOS ${platform.macos} · ${messages.value.cask[platform.arch]} · ${platform.version}`;
}
</script>

<template>
  <section
    v-if="platforms.length"
    class="min-w-0 rounded-big border border-solid border-line-subtle bg-surface-card p-16px"
  >
    <label class="flex flex-col gap-8px text-12.5px text-ink-secondary">
      <span>{{ messages.cask.platform }}</span>
      <select
        :value="selected?.tag"
        class="w-full min-w-0 rounded-small border border-solid border-line-subtle bg-surface-card p-8px text-ink-primary hover:border-ink-secondary focus-visible:outline-none focus-visible:shadow-focus-ring"
        @change="onSelect"
      >
        <option v-for="platform in platforms" :key="platform.tag" :value="platform.tag">{{ label(platform) }}</option>
      </select>
    </label>
    <p v-if="selected?.requiresRosetta" class="m-0 mt-8px text-12.5px text-status-warning">
      {{ messages.cask.rosetta }}
    </p>
    <dl v-if="selected" class="m-0 mt-12px grid grid-cols-1 gap-8px text-12.5px">
      <div v-for="item in requirements" :key="item.label">
        <dt class="text-ink-tertiary">{{ item.label }}</dt>
        <dd class="m-0 mt-4px break-words text-ink-primary">{{ item.value }}</dd>
      </div>
    </dl>
    <details class="mt-12px text-12.5px">
      <summary
        class="cursor-pointer text-ink-secondary hover:text-ink-primary focus-visible:outline-none focus-visible:shadow-focus-ring"
      >
        {{ messages.cask.platforms }}
      </summary>
      <ul class="m-0 mt-8px flex list-none flex-col gap-8px p-0">
        <li
          v-for="platform in platforms"
          :key="platform.tag"
          class="break-words border-t border-t-solid border-line-subtle pt-8px text-ink-primary"
        >
          {{ label(platform) }}
          <span class="block text-ink-tertiary"
            >{{ platform.dependsOn.macos ?? messages.cask.unknown
            }}<template v-if="platform.requiresRosetta"> · {{ messages.cask.rosetta }}</template></span
          >
        </li>
      </ul>
    </details>
    <details v-if="selected && Object.keys(selected.dependsOn.requirements ?? {}).length" class="mt-12px text-12.5px">
      <summary
        class="cursor-pointer text-ink-secondary hover:text-ink-primary focus-visible:outline-none focus-visible:shadow-focus-ring"
      >
        {{ messages.cask.declaration }}
      </summary>
      <pre
        class="m-0 mt-8px max-w-full overflow-x-auto whitespace-pre-wrap break-all font-mono text-12px text-ink-secondary"
        >{{ JSON.stringify(selected.dependsOn.requirements, null, 2) }}</pre
      >
    </details>
  </section>
</template>
