<script setup lang="ts">
import type { Component } from 'vue';
import type { PackageSummary } from '@opennavo/api';
import OnCategoryChips from './OnCategoryChips.vue';
import type { OnCategoryChip } from './OnCategoryChips.vue';
import OnCollectionCard from './OnCollectionCard.vue';
import type { OnCollectionIcon } from './OnCollectionCard.vue';
import OnFeatureHero from './OnFeatureHero.vue';
import type { OnFeatureHeroIcon } from './OnFeatureHero.vue';
import OnSectionHeader from './OnSectionHeader.vue';
import OnSkeleton from './OnSkeleton.vue';
import type { OnAppCardStat } from './OnAppCard.vue';
import OnAppIcon from './OnAppIcon.vue';
import OnButton from './OnButton.vue';
import OnHighlightText from './OnHighlightText.vue';
import OnIcon from './OnIcon.vue';

// Shared Discover presentation (mockup 02, ADR-017): hero, secondary feature, category chips, popular apps, recent updates, collections.
// Host supplies data and card slots, with local-state desktop Get buttons or web open/copy/download menus.
export interface OnDiscoverHero {
  badge: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  icons: readonly OnFeatureHeroIcon[];
  glowColor?: string | null;
}

export interface OnDiscoverCollection {
  key: string;
  title: string;
  subtitle?: string | null;
  count: number;
  icons: readonly OnCollectionIcon[];
  href: string;
}

export interface OnDiscoverFeature extends OnDiscoverHero {
  key: number;
  href?: string;
  external?: boolean;
  detailLabel: string;
}

export interface OnDiscoverLabels {
  categories: string;
  popularApps: string;
  popularAppsHint: string;
  viewRankings: string;
  recentlyUpdated: string;
  recentlyUpdatedHint: string;
  collections: string;
  viewAll: string;
}

export interface OnDiscoverViewProps {
  hero?: OnDiscoverHero | null;
  features?: readonly OnDiscoverFeature[];
  chips: readonly OnCategoryChip<string>[];
  /** null means loading; show skeletons. */
  popular: readonly PackageSummary[] | null;
  recent: readonly PackageSummary[] | null;
  collections?: readonly OnDiscoverCollection[];
  labels: OnDiscoverLabels;
  rankingsHref: string;
  collectionsHref: string;
  /** Web: taller hero at widths ≥1024. */
  responsive?: boolean;
  linkAs?: string | Component;
}

withDefaults(defineProps<OnDiscoverViewProps>(), {
  features: () => [],
  collections: () => [],
  responsive: false,
  linkAs: 'a'
});

defineSlots<{
  /** Environment notice before hero, e.g. desktop offline state. */
  notice?: () => unknown;
  heroActions?: () => unknown;
  card: (props: { pkg: PackageSummary; section: 'popular' | 'recent'; stats?: readonly OnAppCardStat[] }) => unknown;
}>();

const RECENT_STATS: readonly OnAppCardStat[] = ['version', 'installs30d'];
</script>

<template>
  <div class="flex flex-col gap-32px pt-8px">
    <slot name="notice" />

    <OnFeatureHero
      v-if="hero"
      :badge="hero.badge"
      :title="hero.title"
      :subtitle="hero.subtitle ?? undefined"
      :description="hero.description ?? undefined"
      :icons="hero.icons"
      :glow-color="hero.glowColor"
      :responsive="responsive"
    >
      <template #actions>
        <slot name="heroActions" />
      </template>
    </OnFeatureHero>

    <div v-if="features.length" class="grid grid-cols-1 gap-12px md:grid-cols-2">
      <article
        v-for="feature in features"
        :key="feature.key"
        class="on-discover-feature flex min-w-0 flex-col rounded-big border border-solid border-line-subtle bg-surface-card p-24px"
      >
        <div class="flex items-start justify-between gap-16px">
          <div class="min-w-0">
            <span v-if="feature.badge" class="text-12px font-500 text-brand-salmon">{{ feature.badge }}</span>
            <h3 class="m-0 mt-8px text-22px font-600 text-ink-primary">{{ feature.title }}</h3>
            <p v-if="feature.subtitle" class="m-0 mt-6px text-16px font-500 text-brand-salmon">
              {{ feature.subtitle }}
            </p>
          </div>
          <OnAppIcon v-if="feature.icons[0]" v-bind="feature.icons[0]" :size="54" class="shrink-0" />
        </div>
        <OnHighlightText
          v-if="feature.description"
          as="p"
          :text="feature.description"
          class="m-0 mt-12px text-14px leading-[1.65] text-ink-secondary"
        />
        <div v-if="feature.href" class="mt-auto pt-20px">
          <OnButton
            variant="secondary"
            shape="round"
            :href="feature.href"
            :link-as="feature.external ? 'a' : linkAs"
            :target="feature.external ? '_blank' : undefined"
            :rel="feature.external ? 'noopener noreferrer' : undefined"
          >
            {{ feature.detailLabel }}
            <OnIcon name="arrow-up-right" :size="15" />
          </OnButton>
        </div>
      </article>
    </div>

    <OnCategoryChips
      v-if="chips.length > 1"
      :model-value="chips[0]?.value ?? 'all'"
      :items="chips"
      :aria-label="labels.categories"
      :link-as="linkAs"
    />

    <template v-if="popular && recent">
      <section v-if="popular.length">
        <OnSectionHeader
          :title="labels.popularApps"
          :hint="labels.popularAppsHint"
          :more-label="labels.viewRankings"
          :more-href="rankingsHref"
          :link-as="linkAs"
        />
        <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-12px">
          <template v-for="pkg in popular.slice(0, 6)" :key="`${pkg.kind}/${pkg.token}`">
            <slot name="card" :pkg="pkg" section="popular" />
          </template>
        </div>
      </section>

      <section v-if="recent.length">
        <OnSectionHeader :title="labels.recentlyUpdated" :hint="labels.recentlyUpdatedHint" />
        <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-12px">
          <template v-for="pkg in recent.slice(0, 8)" :key="`${pkg.kind}/${pkg.token}`">
            <slot name="card" :pkg="pkg" section="recent" :stats="RECENT_STATS" />
          </template>
        </div>
      </section>
    </template>
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-12px" aria-hidden="true">
      <OnSkeleton v-for="index in 6" :key="index" height="148px" radius="big" />
    </div>

    <section v-if="collections.length">
      <OnSectionHeader
        :title="labels.collections"
        :more-label="labels.viewAll"
        :more-href="collectionsHref"
        :link-as="linkAs"
      />
      <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-12px">
        <OnCollectionCard
          v-for="collection in collections.slice(0, 6)"
          :key="collection.key"
          :title="collection.title"
          :subtitle="collection.subtitle"
          :count="collection.count"
          :icons="collection.icons"
          :href="collection.href"
          :link-as="linkAs"
        />
      </div>
    </section>
  </div>
</template>
