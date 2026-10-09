<script setup lang="ts">
import { computed } from 'vue';
import { parseHighlight } from '../utils/highlight';

export interface OnHighlightTextProps {
  /** Recognize only **…**, emphasizing enclosed phrases with primary text (08 §8.34). */
  text: string;
  as?: 'span' | 'p' | 'div';
}

const props = withDefaults(defineProps<OnHighlightTextProps>(), { as: 'span' });

const parts = computed(() => parseHighlight(props.text));
</script>

<template>
  <component :is="as">
    <template v-for="(part, index) in parts" :key="index">
      <span v-if="part.strong" class="font-500 text-ink-primary">{{ part.text }}</span>
      <template v-else>{{ part.text }}</template>
    </template>
  </component>
</template>
