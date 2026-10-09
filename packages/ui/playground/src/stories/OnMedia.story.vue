<script setup lang="ts">
import { OnCard, OnScreenshotGallery } from '../../../src';
import { OnMarkdown } from '../../../src/markdown';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const shots = [
  { src: '/shot-editor.svg', caption: 'Editor and Copilot chat' },
  { src: '/shot-light.svg', caption: 'Light theme' },
  { src: '/shot-editor.svg' }
];

// Full release body, rendered by OnMarkdown without sections.
const notes = [
  '## New features',
  '',
  '- **Copilot inline suggestions** in the terminal; press `Tab` to accept',
  '- Adds Workspace Trust to settings; see https://code.visualstudio.com/updates',
  '',
  '### Fixes',
  '',
  '1. Fixes lag when searching large files',
  '2. <b>Raw HTML</b> is displayed as text',
  '',
  '```bash',
  'brew upgrade --cask visual-studio-code',
  '```',
  '',
  '> Patch release with no separate release notes.',
  '',
  '| Platform | Size |',
  '|:--|--:|',
  '| Apple silicon | 142 MB |',
  '| Intel | 151 MB |',
  '',
  '![New settings page](https://code.visualstudio.com/assets/updates/settings.png)'
].join('\n');
</script>

<template>
  <StorySection
    title="OnScreenshotGallery / OnMarkdown"
    spec="08 §8.31、§8.32"
    description="Click the gallery to open the lightbox (arrow keys navigate; Escape closes). Markdown disables raw HTML, demotes headings by two levels, and converts images to links."
  >
    <StoryRow label="Screenshot gallery">
      <div class="w-712px">
        <OnScreenshotGallery :items="shots" />
      </div>
    </StoryRow>
    <StoryRow label="Full release notes">
      <OnCard class="w-640px">
        <OnMarkdown :source="notes" />
      </OnCard>
    </StoryRow>
  </StorySection>
</template>
