<script setup lang="ts">
import { formatDate } from '~/utils/packageDate';
import { displayUrl } from '@opennavo/ui';
import { aroundDate, factSources, isoDate } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';

// Sources (T2): every source the page's facts cite, once each, with what it backs and when it was checked.
// A stale source reads "as of" its date; a source without a date is listed without one, never given one.
const props = defineProps<{ pkg: PackagePage }>();

const { t, locale } = useI18n();
const appLocale = computed(() => toAppLocale(locale.value));

const sources = computed(() => factSources(props.pkg));
const items = computed(() =>
  sources.value.map(source => ({
    key: `${source.kind}:${source.url}`,
    label: `${t('package.facts.labelled', { label: t(`package.sources.kinds.${source.kind}`) })}${['zh-CN', 'zh-Hant', 'ja-JP'].includes(appLocale.value) ? '' : ' '}`,
    url: source.url,
    tap: source.kind === 'homebrew' ? props.pkg.tap : null
  }))
);
// A conservative overall date: the oldest dated source, never a fabricated current check.
const checked = computed(() => {
  const dated = sources.value
    .filter(source => source.checkedAt)
    .sort((a, b) => Date.parse(a.checkedAt!) - Date.parse(b.checkedAt!));
  const date = dated[0]?.checkedAt;
  return date
    ? {
        iso: isoDate(date),
        date: formatDate(date, { locale: appLocale.value }),
        ...aroundDate(t, dated.some(source => source.stale) ? 'package.facts.asOf' : 'package.facts.checkedOn')
      }
    : null;
});
</script>

<template>
  <section
    v-if="items.length"
    id="sources"
    class="rounded-big border border-solid border-line-subtle bg-surface-card px-18px py-16px"
    aria-labelledby="sources-title"
    data-testid="package-sources"
  >
    <h2 id="sources-title" class="m-0 text-13.5px font-600 text-ink-primary">
      {{ t('package.sources.title') }}
    </h2>
    <p class="m-0 mt-4px text-12px leading-[1.6] text-ink-tertiary">
      {{ t('package.sources.hint') }}
    </p>
    <ul class="m-0 mt-8px flex list-none flex-col gap-6px p-0 text-12.5px leading-[1.6]">
      <li v-for="item in items" :key="item.key" class="text-ink-tertiary">
        <span class="text-ink-secondary">{{ item.label }}</span
        ><a
          :href="item.url"
          target="_blank"
          rel="nofollow noopener noreferrer"
          class="text-ink-primary underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          >{{ displayUrl(item.url) }}</a
        ><code v-if="item.tap" class="ml-6px font-mono text-11.5px">{{ item.tap }}</code>
      </li>
    </ul>
    <p v-if="checked" class="m-0 mt-10px text-11.5px text-ink-tertiary">
      {{ checked.before }}<time :datetime="checked.iso">{{ checked.date }}</time
      >{{ checked.after }}
    </p>
  </section>
</template>
