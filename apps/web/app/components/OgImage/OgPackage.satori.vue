<script setup lang="ts">
import { cliAbbreviation, darken, iconColor, iconInitials } from '@opennavo/shared';
import type { PackageKind } from '@opennavo/shared';
import { color, radius, shadow } from '@opennavo/tokens';
import OgFrame from '../og/OgFrame.vue';

// Package share image (08 §14): 120 px icon, 56/600 name, summary; missing icons use OnAppIcon's fallback tile.
const props = defineProps<{
  name: string;
  summary?: string;
  kind: PackageKind;
  token: string;
  iconUrl?: string | null;
  accent?: string | null;
  locale?: string;
  footer: string;
}>();

const SIZE = 120;
const box = {
  display: 'flex',
  position: 'relative',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: `${SIZE}px`,
  height: `${SIZE}px`,
  // Match OnAppIcon's radius: 23% of side length.
  borderRadius: `${Math.round((SIZE * Number.parseFloat(radius.appIcon)) / 100)}px`
} as const;

const letterBase = computed(() => iconColor(props.token, props.accent));
</script>

<template>
  <OgFrame :footer="footer" :locale="locale">
    <!-- Use background images: og-image removes unavailable img src attributes, making Satori fail the entire image; missing backgrounds simply stay empty. -->
    <div
      v-if="iconUrl"
      :style="{ ...box, backgroundImage: `url(${iconUrl})`, backgroundSize: `${SIZE}px ${SIZE}px` }"
    ></div>
    <div
      v-else-if="kind === 'cask'"
      :style="{
        ...box,
        backgroundImage: `linear-gradient(160deg, ${letterBase}, ${darken(letterBase)})`,
        color: color.component.letterIconText,
        fontSize: `${Math.round(SIZE * 0.42)}px`,
        fontWeight: 600,
        textShadow: shadow.iconText
      }"
    >
      {{ iconInitials(name) }}
    </div>
    <div
      v-else
      :style="{
        ...box,
        backgroundImage: `linear-gradient(160deg, ${color.component.cliIconFrom}, ${color.component.cliIconTo})`,
        color: color.component.cliIconText,
        fontSize: `${Math.round(SIZE * 0.3)}px`,
        fontWeight: 600,
        letterSpacing: '-0.04em'
      }"
    >
      <!-- Text beside bars needs its own element; Satori drops bare text nodes. -->
      <span>{{ cliAbbreviation(token) }}</span>
      <!-- Bottom bar color depends only on token, matching OnAppIcon; thicken to 3 px for large share images. -->
      <div
        :style="{
          position: 'absolute',
          left: '18%',
          right: '18%',
          bottom: '16%',
          height: '3px',
          borderRadius: `${radius.full}px`,
          backgroundColor: iconColor(token)
        }"
      ></div>
    </div>
    <div :style="{ display: 'flex', flexDirection: 'column', flex: 1, gap: '18px' }">
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
        {{ name }}
      </div>
      <div v-if="summary" :style="{ fontSize: '28px', lineHeight: 1.45, color: color.text.secondary, lineClamp: 2 }">
        {{ summary }}
      </div>
    </div>
  </OgFrame>
</template>
