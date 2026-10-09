<script setup lang="ts">
import { OnAppIcon } from '../../../src';
import type { OnAppIconSize } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const sizes: OnAppIconSize[] = [20, 24, 26, 28, 30, 32, 40, 44, 64, 96, 118];
const casks = [
  { token: 'visual-studio-code', name: 'Visual Studio Code', accent: '#2F8FEF' },
  { token: 'ghostty', name: 'Ghostty', accent: null },
  { token: 'wechat', name: '微信', accent: '#1AAD19' },
  { token: 'google-chrome', name: 'Google Chrome', accent: null },
  { token: 'obsidian', name: 'Obsidian', accent: null },
  { token: 'raycast', name: 'Raycast', accent: null }
];
const formulas = ['ripgrep', 'node', 'python@3.12', 'uv', 'ffmpeg', 'git', 'wget', 'jq'];
</script>

<template>
  <StorySection
    title="OnAppIcon app icons"
    spec="08 §8.10"
    description="Displays available icons with a fallback on failure; casks use letter tiles and formulae use command-line tiles, with colors hashed from the token."
  >
    <StoryRow label="Sizes">
      <OnAppIcon
        v-for="size in sizes"
        :key="size"
        kind="cask"
        token="visual-studio-code"
        name="Visual Studio Code"
        accent="#2F8FEF"
        :size="size"
      />
    </StoryRow>
    <StoryRow label="Letter tiles">
      <OnAppIcon
        v-for="cask in casks"
        :key="cask.token"
        kind="cask"
        :token="cask.token"
        :name="cask.name"
        :accent="cask.accent"
        :size="64"
      />
    </StoryRow>
    <StoryRow label="Command-line tiles">
      <OnAppIcon v-for="token in formulas" :key="token" kind="formula" :token="token" :name="token" :size="64" />
    </StoryRow>
    <StoryRow label="Images and failure fallbacks">
      <OnAppIcon kind="cask" token="opennavo" name="OpenNavo" src="/sample-icon.svg" :size="64" />
      <OnAppIcon kind="cask" token="broken" name="Broken Image" src="/not-found.png" :size="64" />
      <span class="text-caption text-ink-tertiary"
        >The second image URL is missing and falls back to a letter tile</span
      >
    </StoryRow>
  </StorySection>
</template>
