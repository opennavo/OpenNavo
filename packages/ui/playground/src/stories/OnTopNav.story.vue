<script setup lang="ts">
import { ref } from 'vue';
import { OnTopNav } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const items = [
  { label: 'Discover', href: '#discover', active: true },
  { label: 'Categories', href: '#categories' },
  { label: 'Rankings', href: '#rankings' },
  { label: 'Collections', href: '#collections' },
  { label: 'Command line', href: '#cli' }
];

const searches = ref(0);
</script>

<template>
  <StorySection
    title="OnTopNav"
    spec="08 §8.36"
    description="Web top navigation: scrolling applies an 85% opaque blurred background; below 1024px the central menu collapses into a hamburger menu."
  >
    <StoryRow label="Wide screen">
      <div class="w-full overflow-hidden rounded-big border border-solid border-line-subtle">
        <OnTopNav :items="items" download-href="#download" search-shortcut="⌘K" @search="searches++" />
      </div>
    </StoryRow>
    <StoryRow label="Narrow screen">
      <p class="m-0 text-caption text-ink-tertiary">
        The hamburger menu responds to viewport width; resize the browser to preview it. Search clicks: {{ searches }}
      </p>
    </StoryRow>
  </StorySection>
</template>
