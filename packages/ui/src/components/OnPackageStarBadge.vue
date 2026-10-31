<script setup lang="ts">
import OnChip from './OnChip.vue';

export interface OnPackageStarBadgeProps {
  /** Compact count shown on the chip, e.g. 47K (formatRepoStars). */
  label: string;
  /** Full count for screen readers, e.g. "GitHub stars 46,966". */
  accessibleLabel: string;
  /** https GitHub repository URL. */
  href: string;
}
defineProps<OnPackageStarBadgeProps>();
</script>

<template>
  <!-- Header tag row: same md chip as the other tags, linking to the GitHub repository. -->
  <a
    :href="href"
    target="_blank"
    rel="noopener noreferrer nofollow"
    :aria-label="accessibleLabel"
    :title="accessibleLabel"
    data-testid="package-star-badge"
    class="rounded-small no-underline outline-none transition-opacity duration-fast hover:opacity-80 focus-visible:shadow-focus-ring"
  >
    <OnChip size="md" outline><span aria-hidden="true">★</span>&nbsp;{{ label }}</OnChip>
  </a>
</template>
