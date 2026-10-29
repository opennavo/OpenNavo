<script setup lang="ts">
import { isThirdPartyTap } from '@opennavo/shared';
import type { PackageKind } from '@opennavo/shared';
import { displayUrl, OnButton, OnCaskArtifacts, OnCodeText, OnKeyValueList, useUiMessages } from '@opennavo/ui';
import type { OnKeyValueItem } from '@opennavo/ui';
import { detailsDescription } from '~/utils/seoTitles';
import { shownRequirements } from '~/utils/packageFacts';
import PackageRequirements from './PackageRequirements.vue';
import PackageUninstall from './PackageUninstall.vue';
import PackageDependencySummary from './PackageDependencySummary.vue';
import PackageSources from './PackageSources.vue';

// Installation details (08 §10.8): location, bundled commands, uninstall behavior, caveats, download URLs, definition/formulae.brew.sh links.
const props = defineProps<{ kind: PackageKind }>();

const { t } = useI18n();
const { data: pkg, token } = await usePackage(props.kind);
// Link apps have no Homebrew definition; the layout hides this tab for them (usePackage resolves the kind).
if (pkg.value?.kind === 'link') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true });

const messages = useUiMessages();
const toasts = useToasts();
// T6: the download, its checksum, artifacts and caveats come from facts.overview, as on the overview.
const overview = computed(() => pkg.value?.facts.overview);
// Older API data can have summary download facts without a dated per-architecture row.
const download = computed(() => {
  const url = overview.value?.downloadUrl;
  return url && !shownRequirements(pkg.value!).some(row => row.downloadUrl === url) ? url : null;
});
const checksum = computed(() => {
  const sha = overview.value?.sha256;
  return sha && !shownRequirements(pkg.value!).some(row => row.sha256 === sha) ? sha : null;
});
async function copyChecksum() {
  if (!checksum.value) return;
  await navigator.clipboard.writeText(checksum.value);
  toasts.push({ tone: 'success', title: t('toast.copied'), description: 'SHA-256' });
}

const items = computed<OnKeyValueItem[]>(() => {
  const value = pkg.value;
  if (!value) return [];
  const artifacts = value.facts.overview.artifacts;
  const list: OnKeyValueItem[] = [{ key: 'tap', label: t('package.details.tap'), value: value.tap, mono: true }];
  if (value.names.length > 1)
    list.push({ key: 'names', label: t('package.details.names'), value: value.names.join(' · ') });
  if (!artifacts.entries?.length && artifacts.apps.length)
    list.push({ key: 'apps', label: messages.value.cask.source, value: artifacts.apps.join(' · '), mono: true });
  if (artifacts.pkgs.length)
    list.push({ key: 'pkgs', label: t('package.details.pkgs'), value: artifacts.pkgs.join('  '), mono: true });
  if (artifacts.binaries.length)
    list.push({
      key: 'binaries',
      label: t('package.info.binaries'),
      value: artifacts.binaries.join(' '),
      mono: true
    });
  if (artifacts.uninstallNotes?.length)
    list.push({
      key: 'uninstall',
      label: t('package.info.uninstall'),
      value: artifacts.uninstallNotes.join('；')
    });
  if (value.kegOnly)
    list.push({ key: 'keg', label: t('package.details.kegOnly'), value: t('package.details.kegOnlyValue') });
  list.push({
    key: 'source',
    label: t('package.details.source'),
    value: displayUrl(value.sourceUrl),
    href: value.sourceUrl
  });
  // formulae.brew.sh only lists Homebrew's own taps.
  if (!isThirdPartyTap(value.tap))
    list.push({
      key: 'formulae',
      label: 'formulae.brew.sh',
      value: displayUrl(value.formulaeUrl),
      href: value.formulaeUrl
    });
  if (value.repoUrl)
    list.push({ key: 'repo', label: t('package.details.repo'), value: displayUrl(value.repoUrl), href: value.repoUrl });
  return list;
});

usePageSeo({
  title: () => t('package.details.metaTitle', { name: pkg.value?.displayName ?? token.value }),
  description: () => detailsDescription(pkg.value?.displayName ?? token.value, t)
});
</script>

<template>
  <div v-if="pkg" class="grid grid-cols-1 gap-20px pt-4px lg:grid-cols-[minmax(0,1fr)_320px]">
    <div class="flex min-w-0 flex-col gap-16px">
      <PackageRequirements :pkg="pkg" />
      <section class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-4px">
        <OnKeyValueList :items="items" />
      </section>
      <dl
        v-if="download || checksum"
        class="m-0 min-w-0 rounded-big border border-solid border-line-subtle bg-surface-card px-18px py-16px text-12.5px"
      >
        <template v-if="download">
          <dt class="text-ink-tertiary">{{ t('package.details.download') }}</dt>
          <dd class="m-0 mt-6px [overflow-wrap:anywhere]">
            <a :href="download" rel="nofollow noopener noreferrer" class="text-ink-primary">{{ download }}</a>
          </dd>
        </template>
        <template v-if="checksum">
          <dt class="mt-12px text-ink-tertiary first:mt-0">SHA-256</dt>
          <dd class="m-0 mt-6px flex min-w-0 items-center gap-8px text-ink-primary">
            <code class="detail-checksum-full min-w-0 [overflow-wrap:anywhere]">{{ checksum }}</code>
            <code class="detail-checksum-short">{{ checksum.slice(0, 12) }}…</code>
            <OnButton
              size="xs"
              icon="copy"
              class="shrink-0"
              :aria-label="`${t('common.copy')} SHA-256`"
              @click="copyChecksum"
              >{{ t('common.copy') }}</OnButton
            >
          </dd>
        </template>
      </dl>
      <OnCaskArtifacts v-if="overview?.artifacts.entries?.length" :entries="overview.artifacts.entries" />
      <PackageUninstall :pkg="pkg" :homebrew="true" :guide="false" />
      <section
        v-if="overview?.caveats"
        class="rounded-big border border-solid border-status-warning bg-surface-card px-18px py-14px"
      >
        <h2 class="m-0 text-13.5px font-600 text-status-warning">{{ t('package.caveats') }}</h2>
        <pre class="m-0 mt-8px whitespace-pre-wrap font-mono text-12px leading-[1.6] text-ink-secondary"><OnCodeText
          :text="overview.caveats"
        /></pre>
      </section>
      <PackageDependencySummary :pkg="pkg" />
      <PackageSources :pkg="pkg" />
    </div>
  </div>
</template>

<style>
.detail-checksum-short {
  display: none;
}
@media (max-width: 640px) {
  .detail-checksum-full {
    display: none;
  }
  .detail-checksum-short {
    display: inline;
  }
}
</style>
