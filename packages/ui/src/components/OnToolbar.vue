<script setup lang="ts">
import OnIcon from './OnIcon.vue';

// Toolbar (08 §9.1, ADR-017): left slot (desktop back/forward), space, Command-K search, right slot.
// Desktop toolbar/blank region are draggable; never mark buttons/links draggable or clicks fail (06 §4.1).
export interface OnToolbarProps {
  searchLabel: string;
  /** Shortcut hint such as Command-K; hidden when omitted. */
  searchShortcut?: string;
  dragRegion?: boolean;
}

withDefaults(defineProps<OnToolbarProps>(), { dragRegion: false });

const emit = defineEmits<{ search: [] }>();

defineSlots<{ start?: () => unknown; end?: () => unknown }>();
</script>

<template>
  <header
    class="flex h-52px shrink-0 items-center gap-14px pl-18px pr-20px"
    :data-tauri-drag-region="dragRegion ? '' : undefined"
  >
    <div v-if="$slots.start" class="flex items-center gap-2px">
      <slot name="start" />
    </div>
    <div class="flex-1 self-stretch" :data-tauri-drag-region="dragRegion ? '' : undefined"></div>
    <button
      type="button"
      class="m-0 box-border flex h-32px w-340px max-w-full items-center gap-8px rounded-default border border-solid border-line-subtle bg-component-search-bg px-10px font-sans text-13px text-ink-tertiary outline-none transition-colors duration-fast hover:border-line-default focus-visible:shadow-focus-ring"
      :aria-label="searchLabel"
      :aria-keyshortcuts="searchShortcut ? 'Meta+K' : undefined"
      @click="emit('search')"
    >
      <OnIcon name="search" :size="15" />
      <span class="min-w-0 flex-1 truncate text-left">{{ searchLabel }}</span>
      <kbd
        v-if="searchShortcut"
        class="rounded-tiny bg-surface-chip px-6px py-1px font-sans text-11px text-ink-tertiary"
        >{{ searchShortcut }}</kbd
      >
    </button>
    <slot name="end" />
  </header>
</template>
