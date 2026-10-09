<script setup lang="ts">
import type { PackageSummary } from '@opennavo/api';
import { LOCALES, formatCount } from '@opennavo/shared';
import { OnAppIcon, OnButton, OnIcon } from '@opennavo/ui';

// Catalog scale (08 §10.14): title/live count-up, two opposing app-icon rows, Rankings/Discover links.
// Icon wall is decorative, screen-reader-hidden and outside tab order; mouse links open details, hover pauses.
const props = defineProps<{
  apps: readonly PackageSummary[];
  count: number;
  updated: number;
}>();

const { t, locale } = useI18n();
const localePath = useLocalePath();
const NuxtLink = resolveComponent('NuxtLink');
const formattingLocale = computed(() => toAppLocale(locale.value));

const title = computed(() =>
  t(
    'landing.catalog.title',
    { count: formatCount(props.count, { locale: formattingLocale.value }) },
    { plural: props.count }
  )
);

const stats = computed(() =>
  [
    { key: 'apps', value: props.count },
    { key: 'updated', value: props.updated },
    { key: 'languages', value: LOCALES.length }
  ].filter(stat => stat.value > 0)
);

// At least eight items per row, wider than a wide viewport; duplicate for seamless looping.
const rows = computed(() =>
  marqueeRows(props.apps, 2, 8).map((items, index) => ({
    key: index,
    items: [...items, ...items],
    reverse: index % 2 === 1,
    duration: `${items.length * 3.6}s`
  }))
);
</script>

<template>
  <div>
    <div class="mx-auto box-border max-w-1240px px-24px">
      <div data-reveal>
        <LandingSectionHead
          align="center"
          :kicker="t('landing.catalog.kicker')"
          :title="title"
          :body="t('landing.catalog.body')"
        />
      </div>
      <div class="mt-40px flex flex-wrap gap-12px">
        <LandingStat
          v-for="(stat, index) in stats"
          :key="stat.key"
          class="flex-1 basis-[calc(50%-6px)] lg:basis-0"
          :value="stat.value"
          :label="t(`landing.catalog.stats.${stat.key}`)"
          data-reveal
          :style="{ '--landing-delay': `${index * 80}ms` }"
        />
      </div>
    </div>

    <div v-if="rows.length" class="landing-marquee mt-48px flex flex-col gap-12px" aria-hidden="true" data-reveal>
      <div
        v-for="row in rows"
        :key="row.key"
        class="landing-marquee-row overflow-hidden"
        :style="{ '--landing-marquee-duration': row.duration }"
      >
        <div class="landing-marquee-track flex w-max" :class="row.reverse ? 'landing-marquee-reverse' : ''">
          <NuxtLink
            v-for="(pkg, index) in row.items"
            :key="index"
            :to="localePath(`/apps/${pkg.token}`)"
            tabindex="-1"
            class="landing-marquee-item mr-12px box-border inline-flex shrink-0 items-center gap-10px rounded-full border border-solid border-line-subtle bg-surface-card py-6px pl-6px pr-16px text-13.5px font-500 text-ink-secondary no-underline transition-colors duration-fast ease-standard hover:border-line-strong hover:text-ink-primary"
          >
            <OnAppIcon
              kind="cask"
              :token="pkg.token"
              :name="pkg.displayName"
              :src="pkg.iconUrl"
              :accent="pkg.accentColor"
              :size="32"
            />
            <span class="max-w-200px truncate">{{ pkg.displayName }}</span>
          </NuxtLink>
        </div>
      </div>
    </div>

    <div class="mt-36px flex flex-wrap justify-center gap-12px px-24px" data-reveal>
      <OnButton variant="secondary" shape="round" :href="localePath('/rankings')" :link-as="NuxtLink">
        {{ t('home.viewRankings') }}
        <OnIcon name="arrow-right" :size="15" />
      </OnButton>
      <OnButton variant="ghost" shape="round" :href="localePath('/discover')" :link-as="NuxtLink">
        {{ t('landing.hero.browse') }}
      </OnButton>
    </div>
  </div>
</template>

<style>
/* Edge fade uses mask alpha only; any opaque token color works because its color is invisible. */
.landing-marquee-row {
  mask: linear-gradient(90deg, transparent, var(--on-text-primary) 12%, var(--on-text-primary) 88%, transparent);
}

.landing-marquee-track {
  animation: landing-marquee var(--landing-marquee-duration, 48s) linear infinite;
}

.landing-marquee-reverse {
  animation-direction: reverse;
}

.landing-marquee:hover .landing-marquee-track {
  animation-play-state: paused;
}

/* Each item has right margin instead of gap; two copies are exactly twice one copy's width, making 50% translation seamless. */
@keyframes landing-marquee {
  to {
    transform: translateX(-50%);
  }
}
</style>
