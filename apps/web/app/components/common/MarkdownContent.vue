<script setup lang="ts">
import { fnv1a32 } from '@opennavo/shared';
import { OnMarkdownView } from '@opennavo/ui';

// Remote Markdown (descriptions, releases, collections): SSR HTML travels with payload, avoiding initial hydration downloads of
// markdown-it/DOMPurify (about 47 KB, 05 §8); load the renderer only on client navigation to new content.
const props = withDefaults(defineProps<{ source: string; size?: 'sm' | 'md'; headingLevel?: 2 | 3 | 4 | 5 }>(), {
  size: 'sm',
  headingLevel: 3
});

const { data: html } = await useAsyncData(
  () => `markdown:${props.headingLevel}:${props.source.length}:${fnv1a32(props.source).toString(36)}`,
  async () => {
    const { renderMarkdown } = await import('@opennavo/ui/markdown');
    return renderMarkdown(props.source, { headingLevel: props.headingLevel });
  }
);
</script>

<template>
  <OnMarkdownView :html="html ?? ''" :size="size" />
</template>
