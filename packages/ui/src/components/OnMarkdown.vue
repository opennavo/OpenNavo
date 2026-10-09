<script setup lang="ts">
import { computed } from 'vue';
import OnMarkdownView from './OnMarkdownView.vue';
import { renderMarkdown } from '../utils/markdown';

// Browser Markdown rendering for desktop; about 47 KB brotli, exported only through @opennavo/ui/markdown.
// Web SSR renders first, then displays with OnMarkdownView (05 §8).
export interface OnMarkdownProps {
  /** Remote Markdown release/collection bodies; raw HTML appears as text. */
  source: string;
  /** sm is 13/20 for releases; md is 14/1.75 for detail descriptions. */
  size?: 'sm' | 'md';
  /** Highest body heading: two below page h1, default three below section h2, four one level deeper. */
  headingLevel?: 2 | 3 | 4 | 5;
}

const props = withDefaults(defineProps<OnMarkdownProps>(), { size: 'sm', headingLevel: 3 });

const html = computed(() => renderMarkdown(props.source, { headingLevel: props.headingLevel }));
</script>

<template>
  <OnMarkdownView :html="html" :size="size" />
</template>
