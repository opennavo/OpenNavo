<script setup lang="ts">
import { installNote } from '~/utils/appAnswer';
import { downloadChoice } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';
import { installLifecycle } from '~/utils/packageInstall';
import { packagePath } from '~/utils/packageView';
import { trackEvent } from '~/utils/analytics';

// One overview guide; download addresses, checksums and file declarations live in Install details.
const props = defineProps<{ pkg: PackagePage }>();
const { t } = useI18n();
const localePath = useLocalePath();
const toasts = useToasts();
const note = computed(() => installNote(props.pkg));
const download = computed(() => downloadChoice(props.pkg));
const lifecycle = computed(() => installLifecycle(props.pkg, t));
const state = computed(() => lifecycle.value.state);
const notice = computed(() => lifecycle.value.notice);
// H9: when the server consolidates Install details into the overview, the layout 301s the details
// page here. Link the same-page body instead (rendered by the overview), never the redirected tab.
const detailsRedirect = computed(() => Boolean(props.pkg.indexing?.detailsRedirect));
const detailsHref = computed(() =>
  detailsRedirect.value ? '#install-details' : `${localePath(packagePath(props.pkg.token, 'details'))}#requirements`
);
function onCopied(command: string) {
  toasts.push({ tone: 'success', title: t('toast.copied'), description: command });
  trackEvent('copy_install_command');
}
</script>

<template>
  <section
    id="install"
    class="rounded-big border border-solid border-line-subtle bg-surface-card px-18px py-16px"
    aria-labelledby="install-title"
    data-testid="package-install"
  >
    <h2 id="install-title" class="m-0 text-13.5px font-600 text-ink-primary">
      {{ t('package.install.title', { name: pkg.displayName }) }}
    </h2>
    <div class="package-overview-install-command mt-10px" data-testid="package-install-command">
      <p
        v-if="notice"
        role="note"
        class="m-0 mb-10px rounded-default border border-solid px-12px py-10px text-12.5px leading-[1.6]"
        :class="
          state === 'disabled' ? 'border-status-danger text-status-danger' : 'border-status-warning text-status-warning'
        "
      >
        {{ notice }}
      </p>
      <PackageCommand
        v-if="state !== 'disabled'"
        :command="pkg.installCommand"
        :copy-label="t('package.copy.install')"
        @copied="onCopied"
      />
    </div>
    <p v-if="note && state !== 'disabled'" class="m-0 mt-8px text-13px leading-[1.6] text-ink-secondary">
      {{
        note.key === 'installPkg' ? t('package.guide.installPkg', { pkg: note.pkg }) : t(`package.guide.${note.key}`)
      }}
    </p>
    <details
      v-if="download"
      class="mt-12px text-13px leading-[1.6] text-ink-secondary"
      data-testid="package-without-homebrew"
    >
      <summary
        class="cursor-pointer text-12.5px font-600 text-ink-primary outline-none focus-visible:shadow-focus-ring"
      >
        {{ t('package.guide.downloadTitle') }}
      </summary>
      <p class="m-0 mt-6px">
        {{
          t(
            download.kind === 'direct'
              ? 'package.guide.downloadDirect'
              : download.kind === 'arch'
                ? 'package.guide.downloadArch'
                : download.varies
                  ? 'package.guide.downloadVaries'
                  : 'package.guide.downloadOfficial'
          )
        }}
        <NuxtLink :to="detailsHref" class="text-ink-primary underline-offset-2 hover:underline">
          {{ t('package.tabs.details') }}
        </NuxtLink>
      </p>
    </details>
    <PackageUninstall v-if="!detailsRedirect && state !== 'disabled'" :pkg="pkg" :homebrew="true" compact />
  </section>
</template>
