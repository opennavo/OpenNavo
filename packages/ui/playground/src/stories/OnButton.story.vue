<script setup lang="ts">
import { OnButton } from '../../../src';
import type { OnButtonSize, OnButtonVariant } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const variants: OnButtonVariant[] = ['primary', 'secondary', 'accent', 'ghost', 'danger'];
const sizes: OnButtonSize[] = ['xs', 'sm', 'md', 'lg'];
const labels: Record<OnButtonVariant, string> = {
  primary: 'AllUpdates（6）',
  secondary: 'ViewDetails',
  accent: 'Install Homebrew',
  ghost: 'Check for updates',
  danger: 'Uninstall'
};
</script>

<template>
  <StorySection
    title="OnButton buttons"
    spec="08 §8.1"
    description="Five variants in four sizes, including pill, icon, icon-only, loading, and disabled states."
  >
    <StoryRow v-for="variant in variants" :key="variant" :label="variant">
      <OnButton :variant="variant">{{ labels[variant] }}</OnButton>
      <OnButton :variant="variant" icon="lucide:download">{{ labels[variant] }}</OnButton>
      <OnButton :variant="variant" shape="round">{{ labels[variant] }}</OnButton>
      <OnButton :variant="variant" icon="lucide:copy" icon-only aria-label="Copy" />
      <OnButton :variant="variant" loading>{{ labels[variant] }}</OnButton>
      <OnButton :variant="variant" disabled>{{ labels[variant] }}</OnButton>
    </StoryRow>
    <StoryRow label="Sizes xs–lg">
      <OnButton v-for="size in sizes" :key="size" variant="primary" :size="size" icon="lucide:download">
        Get {{ size }}
      </OnButton>
    </StoryRow>
    <StoryRow label="Links and full width">
      <OnButton href="#button" shape="round" icon="lucide:arrow-up-right">ViewDetails</OnButton>
      <div class="w-240px"><OnButton variant="secondary" block>Install collection in one click</OnButton></div>
    </StoryRow>
  </StorySection>
</template>
