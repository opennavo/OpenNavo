<script setup lang="ts">
import { isThirdPartyTap } from '@opennavo/shared';
import { displayUrl, OnButton, OnCaskArtifacts, OnCodeText, OnKeyValueList, useUiMessages } from '@opennavo/ui';
import type { OnKeyValueItem } from '@opennavo/ui';
import { shownRequirements } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';
import { installLifecycle } from '~/utils/packageInstall';
import PackageCommand from './PackageCommand.vue';
import PackagePrice from './PackagePrice.vue';
import PackageRequirements from './PackageRequirements.vue';
import PackageSafety from './PackageSafety.vue';
import PackageUninstall from './PackageUninstall.vue';
import PackageDependencySummary from './PackageDependencySummary.vue';
import PackageSources from './PackageSources.vue';

// Installation details (08 §10.8): the install command, system requirements, price, safety facts, tap and
// former tokens, bundled commands, uninstall behavior, download URLs and checksums, caveats, dependency
// summary, definition/formulae.brew.sh links and sources. The details page renders it with the command;
// the overview renders the same body when the server redirects details there, so no content is lost.
const props = withDefaults(
  defineProps<{
    pkg: PackagePage;
    /** The overview already shows the command in PackageInstall, so it omits the duplicate. */
    showCommand?: boolean;
    /** The overview links on to the uninstall page; the details page keeps the tab self-contained. */
    uninstallGuide?: boolean;
  }>(),
  { showCommand: true, uninstallGuide: false }
);

const { t } = useI18n();
const toasts = useToasts();
const lifecycle = computed(() => installLifecycle(props.pkg, t));
const commandState = computed(() => lifecycle.value.state);
const commandNotice = computed(() => lifecycle.value.notice);
const overview = computed(() => props.pkg.facts.overview);
// Older API data can have summary download facts without a dated per-architecture row.
const download = computed(() => {
  const url = overview.value?.downloadUrl;
  return url && !shownRequirements(props.pkg).some(row => row.downloadUrl === url) ? url : null;
});
const checksum = computed(() => {
  const sha = overview.value?.sha256;
  return sha && !shownRequirements(props.pkg).some(row => row.sha256 === sha) ? sha : null;
});
async function copyChecksum() {
  if (!checksum.value) return;
  try {
    await navigator.clipboard.writeText(checksum.value);
    toasts.push({ tone: 'success', title: t('toast.copied'), description: 'SHA-256' });
  } catch {
    toasts.push({ tone: 'warning', title: t('toast.copyFailed'), description: 'SHA-256', duration: 0 });
  }
}

function onCopied(command: string) {
  toasts.push({ tone: 'success', title: t('toast.copied'), description: command });
}

const messages = useUiMessages();
const items = computed<OnKeyValueItem[]>(() => {
  const value = props.pkg;
  const artifacts = value.facts.overview.artifacts;
  const list: OnKeyValueItem[] = [{ key: 'tap', label: t('package.details.tap'), value: value.tap, mono: true }];
  if (value.facts.overview.aliases.length)
    list.push({
      key: 'aliases',
      label: t('package.details.aliases'),
      value: value.facts.overview.aliases.join(', '),
      mono: true
    });
  if (value.names.length > 1)
    list.push({ key: 'names', label: t('package.details.names'), value: value.names.join(' · ') });
  if (!artifacts.entries?.length && artifacts.apps.length)
    list.push({
      key: 'apps',
      label: messages.value.cask.source,
      value: artifacts.apps.join(' · '),
      mono: true
    });
  if (artifacts.pkgs.length)
    list.push({
      key: 'pkgs',
      label: t('package.details.pkgs'),
      value: artifacts.pkgs.join('  '),
      mono: true
    });
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
    list.push({
      key: 'keg',
      label: t('package.details.kegOnly'),
      value: t('package.details.kegOnlyValue')
    });
  list.push({
    key: 'source',
    label: t('package.details.source'),
    value: displayUrl(value.sourceUrl),
    href: value.sourceUrl
  });
  // formulae.brew.sh only lists Homebrew's own taps.
  if (!isThirdPartyTap(value.tap) && value.formulaeUrl)
    list.push({
      key: 'formulae',
      label: 'formulae.brew.sh',
      value: displayUrl(value.formulaeUrl),
      href: value.formulaeUrl
    });
  if (value.repoUrl)
    list.push({
      key: 'repo',
      label: t('package.details.repo'),
      value: displayUrl(value.repoUrl),
      href: value.repoUrl
    });
  return list;
});
</script>

<template>
  <div id="install-details" class="flex flex-col gap-20px pt-4px" data-testid="package-install-details">
    <div class="flex min-w-0 flex-col gap-16px">
      <section
        v-if="showCommand"
        class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-14px"
        data-testid="package-install-command"
      >
        <p
          v-if="commandNotice"
          role="note"
          data-testid="package-install-notice"
          class="m-0 mb-10px rounded-default border border-solid px-12px py-10px text-12.5px leading-[1.6]"
          :class="
            commandState === 'disabled'
              ? 'border-status-danger text-status-danger'
              : 'border-status-warning text-status-warning'
          "
        >
          {{ commandNotice }}
        </p>
        <PackageCommand
          v-if="commandState !== 'disabled'"
          :command="pkg.installCommand"
          :copy-label="t('package.copy.install')"
          @copied="onCopied"
        />
      </section>
      <PackageRequirements :pkg="pkg" />
      <p v-if="overview?.sha256" class="m-0 text-12px leading-[1.6] text-ink-tertiary">
        {{ t('package.guide.sha') }}
      </p>
      <PackagePrice :pkg="pkg" />
      <PackageSafety v-if="!pkg.isFont" :pkg="pkg" :show-checked="false" />
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
              :aria-label="t('download.copySha')"
              @click="copyChecksum"
              >{{ t('common.copy') }}</OnButton
            >
          </dd>
        </template>
      </dl>
      <OnCaskArtifacts v-if="overview?.artifacts.entries?.length" :entries="overview.artifacts.entries" />
      <PackageUninstall :pkg="pkg" :homebrew="true" :guide="uninstallGuide" :show-checked="false" />
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
