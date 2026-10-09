<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import { BRAND } from '@opennavo/shared';
import { OnLogo } from '../../src';
import { locale } from './main';
import OnAppCardStory from './stories/OnAppCard.story.vue';
import OnAppIconStory from './stories/OnAppIcon.story.vue';
import OnDetailPartsStory from './stories/OnDetailParts.story.vue';
import OnFeatureHeroStory from './stories/OnFeatureHero.story.vue';
import OnMediaStory from './stories/OnMedia.story.vue';
import OnNavigationStory from './stories/OnNavigation.story.vue';
import OnOverlaysStory from './stories/OnOverlays.story.vue';
import OnStatesStory from './stories/OnStates.story.vue';
import OnBadgeStory from './stories/OnBadge.story.vue';
import OnButtonStory from './stories/OnButton.story.vue';
import OnCardStory from './stories/OnCard.story.vue';
import OnDataStory from './stories/OnData.story.vue';
import OnChipStory from './stories/OnChip.story.vue';
import OnGetButtonStory from './stories/OnGetButton.story.vue';
import OnIconStory from './stories/OnIcon.story.vue';
import OnLogoStory from './stories/OnLogo.story.vue';
import OnSearchFieldStory from './stories/OnSearchField.story.vue';
import OnSegmentedStory from './stories/OnSegmented.story.vue';
import OnStatTileStory from './stories/OnStatTile.story.vue';
import OnTabsStory from './stories/OnTabs.story.vue';
import OnToggleStory from './stories/OnToggle.story.vue';
import OnTooltipStory from './stories/OnTooltip.story.vue';
import OnTopNavStory from './stories/OnTopNav.story.vue';
import OnViewsStory from './stories/OnViews.story.vue';

const stories: Array<{ name: string; component: Component }> = [
  { name: 'OnButton', component: OnButtonStory },
  { name: 'OnGetButton', component: OnGetButtonStory },
  { name: 'OnChip', component: OnChipStory },
  { name: 'OnBadge', component: OnBadgeStory },
  { name: 'OnSegmented', component: OnSegmentedStory },
  { name: 'OnToggle', component: OnToggleStory },
  { name: 'OnSearchField', component: OnSearchFieldStory },
  { name: 'OnCard', component: OnCardStory },
  { name: 'OnStatTile', component: OnStatTileStory },
  { name: 'OnAppIcon', component: OnAppIconStory },
  { name: 'OnTabs', component: OnTabsStory },
  { name: 'OnTooltip', component: OnTooltipStory },
  { name: 'OnLogo', component: OnLogoStory },
  { name: 'OnAppCard', component: OnAppCardStory },
  { name: 'OnFeatureHero', component: OnFeatureHeroStory },
  { name: 'OnDetailParts', component: OnDetailPartsStory },
  { name: 'OnMedia', component: OnMediaStory },
  { name: 'OnTopNav', component: OnTopNavStory },
  { name: 'OnOverlays', component: OnOverlaysStory },
  { name: 'OnData', component: OnDataStory },
  { name: 'OnNavigation', component: OnNavigationStory },
  { name: 'OnStates', component: OnStatesStory },
  { name: 'OnIcon', component: OnIconStory },
  { name: 'OnViews', component: OnViewsStory }
];

// ?story=OnButton shows one component for isolated screenshots.
const selected = new URLSearchParams(location.search).get('story');
const visible = computed(() => stories.filter(story => !selected || story.name === selected));

function switchLocale() {
  locale.value = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN';
}
</script>

<template>
  <div class="min-h-screen bg-surface-page text-ink-primary">
    <header class="border-b border-b-solid border-line-subtle bg-surface-page px-32px py-14px">
      <div class="mx-auto flex max-w-1240px items-center gap-12px">
        <OnLogo inline aria-hidden="true" />
        <span class="text-headline text-brand-coral">{{ BRAND.name }}</span>
        <span class="text-body-sm text-ink-tertiary">@opennavo/ui playground</span>
        <nav class="ml-auto flex flex-wrap gap-12px" aria-label="Components">
          <a
            v-for="story in stories"
            :key="story.name"
            :href="`?story=${story.name}`"
            class="text-12px text-ink-tertiary no-underline hover:text-ink-primary"
          >
            {{ story.name.slice(2) }}
          </a>
          <a href="?" class="text-12px text-ink-tertiary no-underline hover:text-ink-primary">All</a>
        </nav>
        <button
          type="button"
          class="rounded-small border border-solid border-line-default bg-transparent px-8px py-4px text-12px text-ink-secondary"
          @click="switchLocale"
        >
          {{ locale }}
        </button>
      </div>
    </header>
    <main class="mx-auto flex max-w-1240px flex-col gap-20px px-32px py-28px">
      <component :is="story.component" v-for="story in visible" :id="story.name" :key="story.name" />
    </main>
  </div>
</template>
