<script setup lang="ts">
import { ApiError, unwrap } from '@opennavo/api';
import { formatBytes, formatDate, formatVersion } from '@opennavo/shared';
import { OnButton, OnEmpty, OnIcon, OnInstallCommand, OnLogo } from '@opennavo/ui';
import { DESKTOP_BREW_COMMAND } from '~/utils/download';

const { locale: useI18nLocale } = useI18n();
const formattingLocale = computed(() => toAppLocale(useI18nLocale.value));

// Download (05 §7.4, 08 §10.14): title, glow, Universal DMG, three feature columns, latest notes.
const { t, locale } = useI18n();
const api = useApi();
const toasts = useToasts();
const appLocale = computed(() => toAppLocale(locale.value));

const { data: release, error } = await useAsyncData(
  () => `desktop-release:${locale.value}`,
  () =>
    unwrap(api.GET('/desktop/releases/latest', { params: { query: { channel: 'stable' } } })).catch(
      (reason: unknown) => {
        // API 404 before the first release means Coming soon, not an error.
        if (reason instanceof ApiError && (reason.isNotFound || reason.status === 404)) return null;
        throw reason;
      }
    )
);

const dmg = computed(() => release.value?.downloads.find(item => item.target === 'dmg-universal'));

const changelog = computed(() => {
  const value = release.value;
  if (!value) return [];
  const recent = value.recentReleases?.length
    ? value.recentReleases
    : [{ version: value.version, pubDate: value.pubDate, notes: value.notes }];
  return recent.filter(entry => entry.notes).slice(0, 5);
});

const features = computed(() =>
  (['install', 'updates', 'history'] as const).map(key => ({
    key,
    icon: { install: 'download', updates: 'circle-arrow-down', history: 'rotate-ccw-clock' }[key],
    title: t(`download.features.${key}.title`),
    body: t(`download.features.${key}.body`)
  }))
);

async function copySha(sha: string) {
  try {
    await navigator.clipboard.writeText(sha);
    toasts.push({ tone: 'success', title: t('download.shaCopied') });
  } catch {
    toasts.push({ tone: 'warning', title: t('toast.copyFailed'), description: sha, duration: 0 });
  }
}

function onCopied(command: string) {
  toasts.push({ tone: 'success', title: t('toast.copied'), description: command });
}

usePageSeo({ title: () => t('download.metaTitle'), description: () => t('download.description') });
</script>

<template>
  <div>
    <GlowCover>
      <div class="mx-auto box-border flex max-w-960px flex-col items-center pb-56px pt-56px text-center md:pt-80px">
        <OnLogo :size="56" />
        <h1 class="m-0 mt-24px text-display text-ink-primary md:text-section">{{ t('download.title') }}</h1>
        <p class="m-0 mt-16px max-w-640px text-16px leading-[1.65] text-ink-secondary">
          {{ t('download.description') }}
        </p>
        <div v-if="release && dmg" class="mt-32px flex flex-col items-center gap-10px">
          <OnButton variant="primary" size="lg" shape="round" icon="download" :href="dmg.url">
            {{ t('download.button') }}
          </OnButton>
          <p class="m-0 text-12.5px text-ink-tertiary">
            {{
              t('download.meta', {
                version: formatVersion(release.version),
                size: formatBytes(dmg.bytes, { locale: formattingLocale }),
                macos: release.minMacos,
                date: formatDate(release.pubDate, { locale: appLocale })
              })
            }}
          </p>
          <button
            type="button"
            class="m-0 inline-flex max-w-full items-center gap-6px rounded-tiny border-none bg-transparent p-0 font-mono text-11px text-ink-tertiary outline-none hover:text-ink-primary focus-visible:shadow-focus-ring"
            :aria-label="t('download.copySha')"
            @click="copySha(dmg.sha256)"
          >
            SHA-256 <span class="truncate">{{ dmg.sha256 }}</span>
            <OnIcon name="copy" :size="12" />
          </button>
        </div>
        <OnEmpty
          v-else-if="!error"
          class="mt-16px"
          icon="lucide:clock"
          :title="t('download.comingTitle')"
          :description="t('download.comingDescription')"
        />
      </div>
    </GlowCover>

    <div class="mx-auto box-border flex max-w-960px flex-col gap-28px">
      <section class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-14px">
        <OnInstallCommand
          :title="t('download.brewTitle')"
          :command="DESKTOP_BREW_COMMAND"
          :wrap-at="80"
          @copied="onCopied"
        />
      </section>
      <ul class="m-0 grid list-none grid-cols-1 gap-12px p-0 md:grid-cols-3">
        <li
          v-for="feature in features"
          :key="feature.key"
          class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-16px"
        >
          <OnIcon :name="feature.icon" :size="20" class="text-brand-salmon" />
          <h2 class="m-0 mt-10px text-14px font-600 text-ink-primary">{{ feature.title }}</h2>
          <p class="m-0 mt-6px text-13px leading-[1.6] text-ink-secondary">{{ feature.body }}</p>
        </li>
      </ul>
      <!-- Changelog: latest five versions, or just latest when older backends provide only one. -->
      <section v-if="changelog.length" class="flex flex-col gap-12px">
        <h2 class="m-0 text-headline text-ink-primary">{{ t('download.changelog') }}</h2>
        <article
          v-for="entry in changelog"
          :key="entry.version"
          class="rounded-big border border-solid border-line-subtle bg-surface-card px-18px py-14px"
        >
          <h3 class="m-0 flex items-baseline gap-8px text-14px font-600 text-ink-primary">
            {{ formatVersion(entry.version) }}
            <small class="text-12px font-400 text-ink-tertiary">{{
              formatDate(entry.pubDate, { locale: appLocale })
            }}</small>
          </h3>
          <MarkdownContent class="mt-8px" :heading-level="4" :source="entry.notes" />
        </article>
      </section>
    </div>
  </div>
</template>
