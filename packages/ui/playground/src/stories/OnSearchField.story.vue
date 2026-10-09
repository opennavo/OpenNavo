<script setup lang="ts">
import { ref } from 'vue';
import { OnSearchField } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const empty = ref('');
const filled = ref('vscode');
const submitted = ref('');
</script>

<template>
  <StorySection
    title="OnSearchField search fields"
    spec="08 §8.7"
    description="Enter submits and Escape clears; when content is present, a clear button replaces the shortcut hint."
  >
    <StoryRow label="Empty + shortcut">
      <div class="w-340px">
        <OnSearchField
          v-model="empty"
          placeholder="Search 16,413 apps and command-line tools"
          shortcut="⌘K"
          @submit="submitted = $event"
        />
      </div>
    </StoryRow>
    <StoryRow label="With content">
      <div class="w-340px">
        <OnSearchField v-model="filled" placeholder="Search" shortcut="⌘K" @submit="submitted = $event" />
      </div>
      <span class="text-caption text-ink-tertiary">Last submission: {{ submitted || 'None' }}</span>
    </StoryRow>
    <StoryRow label="Disabled">
      <div class="w-220px">
        <OnSearchField model-value="" placeholder="Filter installed packages" disabled />
      </div>
    </StoryRow>
  </StorySection>
</template>
