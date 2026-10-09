<script setup lang="ts">
// Shared statistics rail frame (08 §9.1, ADR-017): width 288, left divider, independent content scrolling.
export interface OnRailPanelProps {
  /** Web below xl: move under main content, use document scrolling and top border instead of left (05 §11.2). */
  responsive?: boolean;
}

withDefaults(defineProps<OnRailPanelProps>(), { responsive: false });
defineSlots<{ default?: () => unknown }>();
</script>

<template>
  <aside
    class="flex min-w-0 flex-col gap-22px overflow-x-hidden bg-surface-rail py-18px"
    :class="
      responsive
        ? 'box-border border-t border-t-solid border-line-sidebar px-16px md:px-28px xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-l xl:border-t-0 xl:border-l-solid xl:px-20px'
        : 'h-full min-h-0 overflow-y-auto border-l border-l-solid border-line-sidebar px-20px'
    "
  >
    <slot />
  </aside>
</template>
