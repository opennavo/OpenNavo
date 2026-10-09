<script setup lang="ts">
import { computed } from 'vue';
import { LOGO } from '@opennavo/shared';
import { color, effect } from '@opennavo/tokens';

// Share-image frame (08 §14): 1200×630, surface.page background, lower-right glow, OpenNavo/Homebrew app-store footer.
// Satori lacks CSS variables/class themes; use @opennavo/tokens constants directly and public/fonts Chinese subsets.
// Keep outside components/OgImage, where every file becomes a template and cannot resolve neighboring templates.
const props = defineProps<{ footer: string; locale?: string }>();

defineSlots<{ default?: () => unknown }>();

const font = computed(() => (props.locale?.startsWith('ja') ? 'OG Noto Sans JP' : 'OG Noto Sans SC'));
// Footer logo uses tight bounds for accurate text spacing; Satori needs numeric dimensions.
const LOGO_HEIGHT = 32;
const geometry = LOGO.small;
const LOGO_WIDTH = Math.round(LOGO_HEIGHT * geometry.markAspect);
const FOOTER_SIZE = 24;
// Raise footer logo to align N/text (08 §2). Satori builds line boxes from font ascender/descender (1160/-288, cap height 733, per 1000 em).
// Cap center is (1160 - 288 - 733) / 2 / 1000 em below line center; subtract that from the logo shift.
const LOGO_SHIFT = LOGO_HEIGHT * geometry.nCenterOffset - ((1160 - 288 - 733) / 2000) * FOOTER_SIZE;
</script>

<template>
  <div
    :style="{
      width: '1200px',
      height: '630px',
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: color.surface.page,
      fontFamily: font,
      fontWeight: 400
    }"
  >
    <div
      :style="{
        position: 'absolute',
        right: '-260px',
        bottom: '-360px',
        width: '900px',
        height: '900px',
        backgroundImage: effect.heroGlow,
        opacity: 0.75
      }"
    ></div>
    <div
      :style="{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        padding: '72px 80px'
      }"
    >
      <div :style="{ display: 'flex', alignItems: 'center', gap: '40px' }">
        <slot />
      </div>
      <div
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          fontSize: `${FOOTER_SIZE}px`,
          color: color.text.tertiary
        }"
      >
        <svg
          :viewBox="geometry.markViewBox"
          :width="LOGO_WIDTH"
          :height="LOGO_HEIGHT"
          :style="{ transform: `translateY(-${LOGO_SHIFT.toFixed(2)}px)` }"
        >
          <path :fill="color.brand.coral" :d="geometry.outerPath" />
          <path :fill="color.brand.logoCoreGradient[1]" :d="geometry.innerPath" />
        </svg>
        <span>{{ footer }}</span>
      </div>
    </div>
  </div>
</template>
