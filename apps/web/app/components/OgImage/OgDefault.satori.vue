<script setup lang="ts">
import { color } from '@opennavo/tokens';
import OgFrame from '../og/OgFrame.vue';

// Default share image: title/description; wrap by words and balance two lines to avoid splitting App Store.
defineProps<{ title: string; description?: string; locale?: string; footer: string }>();
</script>

<template>
  <OgFrame :footer="footer" :locale="locale">
    <div :style="{ display: 'flex', flexDirection: 'column', flex: 1, gap: '22px' }">
      <div
        :style="{
          fontSize: '56px',
          fontWeight: 600,
          lineHeight: 1.15,
          color: color.text.primary,
          letterSpacing: '-0.02em',
          wordBreak: 'keep-all',
          textWrap: 'balance'
        }"
      >
        {{ title }}
      </div>
      <div v-if="description" :style="{ fontSize: '28px', lineHeight: 1.5, color: color.text.secondary, lineClamp: 3 }">
        {{ description }}
      </div>
    </div>
  </OgFrame>
</template>
