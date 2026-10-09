<script setup lang="ts">
import { computed, ref } from 'vue';
import { OnMarkdown } from '@opennavo/ui/markdown';
import { $t } from '@/locales';

defineOptions({ name: 'MarkdownEditor' });

interface Props {
  maxlength?: number;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}

withDefaults(defineProps<Props>(), { maxlength: undefined, rows: 10, placeholder: '', disabled: false });

const value = defineModel<string>({ default: '' });

// Edit/preview tabs; preview uses public rendering/sanitization on the public dark surface (07 §7).
const mode = ref<'edit' | 'preview'>('edit');
const empty = computed(() => !value.value.trim());
</script>

<template>
  <div class="w-full flex-col gap-8px">
    <NRadioGroup v-model:value="mode" size="small">
      <NRadioButton value="edit">{{ $t('page.shared.markdown.edit') }}</NRadioButton>
      <NRadioButton value="preview">{{ $t('page.shared.markdown.preview') }}</NRadioButton>
    </NRadioGroup>
    <NInput
      v-if="mode === 'edit'"
      v-model:value="value"
      type="textarea"
      :rows="rows"
      :maxlength="maxlength"
      :show-count="Boolean(maxlength)"
      :placeholder="placeholder"
      :disabled="disabled"
      class="font-mono"
    />
    <div v-else class="markdown-preview min-h-120px rounded-default bg-surface-card px-16px py-12px">
      <OnMarkdown v-if="!empty" :source="value" :heading-level="2" />
      <NText v-else depth="3">—</NText>
    </div>
  </div>
</template>
