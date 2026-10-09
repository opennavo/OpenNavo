<script setup lang="ts">
import { OnButton, OnTooltip } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';
</script>

<template>
  <StorySection
    title="OnTooltip tooltips"
    spec="08 §8.24"
    description="Appears after 400 ms and also opens on keyboard focus; Escape closes it. The second row shows static tooltips for screenshot comparisons."
  >
    <StoryRow label="Four directions">
      <OnTooltip content="Copy installation command" placement="top">
        <OnButton icon="lucide:copy" icon-only aria-label="Copy" />
      </OnTooltip>
      <OnTooltip content="Show in Finder" placement="bottom">
        <OnButton icon="lucide:folder" icon-only aria-label="Finder" />
      </OnTooltip>
      <OnTooltip content="More actions" placement="left">
        <OnButton icon="lucide:ellipsis" icon-only aria-label="More" />
      </OnTooltip>
      <OnTooltip content="Check for updates (⌘R)" placement="right">
        <OnButton icon="lucide:refresh-cw" icon-only aria-label="Check for updates" />
      </OnTooltip>
    </StoryRow>
    <StoryRow label="Static appearance">
      <span
        class="inline-flex w-max rounded-small border border-solid border-line-default bg-surface-control px-9px py-6px text-11.5px leading-16px text-ink-primary shadow-popover"
      >
        brew install --cask visual-studio-code
      </span>
    </StoryRow>
  </StorySection>
</template>
