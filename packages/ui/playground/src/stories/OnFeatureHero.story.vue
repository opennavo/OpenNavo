<script setup lang="ts">
import { ref } from 'vue';
import { OnFeatureHero } from '../../../src';
import type { OnFeatureHeroIcon } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

// Weekly feature from mockup 02-discover.
const icons: OnFeatureHeroIcon[] = [
  { kind: 'cask', token: 'ghostty', name: 'Ghostty', src: '/ghostty.svg' },
  { kind: 'cask', token: 'iterm2', name: 'iTerm2', src: '/iterm2.svg' },
  { kind: 'cask', token: 'zed', name: 'Zed', src: '/zed.svg' }
];

const actions = ref(0);
</script>

<template>
  <StorySection
    title="OnFeatureHero"
    spec="08 §8.13"
    description="Matches the design at a desktop content width of 712; responsive web mode increases height to 360 at widths of 1024 and above. glowColor overrides the glow accent."
  >
    <StoryRow label="Desktop (712)">
      <div class="w-712px">
        <OnFeatureHero
          badge="Featured this week"
          title="Ghostty 1.3"
          subtitle="Terminals should be this fast."
          description="Native macOS interface with GPU-accelerated rendering. **14,326 installs in the last 30 days; number 10 in casks.**"
          :icons="icons"
          detail-href="#ghostty"
          @action="actions++"
        />
      </div>
    </StoryRow>
    <StoryRow label="Accent glow">
      <div class="w-712px">
        <OnFeatureHero
          badge="Editor picks"
          title="Zed"
          subtitle="A collaborative code editor."
          description="Written in Rust; **starts in under one second**."
          :icons="[icons[2] as OnFeatureHeroIcon]"
          glow-color="#3C96F5"
          detail-href="#zed"
        />
      </div>
    </StoryRow>
    <StoryRow label="Web">
      <div class="w-full">
        <OnFeatureHero
          responsive
          badge="Featured this week"
          title="Ghostty 1.3"
          subtitle="Terminals should be this fast."
          description="Native macOS interface with GPU-accelerated rendering. **14,326 installs in the last 30 days; number 10 in casks.**"
          :icons="icons"
          detail-href="#ghostty"
        />
      </div>
    </StoryRow>
    <p class="m-0 text-caption text-ink-tertiary">Get clicks: {{ actions }}</p>
  </StorySection>
</template>
