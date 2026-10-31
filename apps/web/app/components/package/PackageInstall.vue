<script setup lang="ts">
import { installNote } from '~/utils/appAnswer';
import { downloadChoice } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';
import { installLifecycle } from '~/utils/packageInstall';
import { packagePath } from '~/utils/packageView';

// One overview guide; the install command and lifecycle notice live in the shared header, while download
// addresses, checksums and file declarations live in Install details.
const props = defineProps<{ pkg: PackagePage }>();
const { t } = useI18n();
const localePath = useLocalePath();
const note = computed(() => installNote(props.pkg));
const download = computed(() => downloadChoice(props.pkg));
const state = computed(() => installLifecycle(props.pkg, t).state);
// H9: when the server consolidates Install details into the overview, the layout 301s the details
// page here. Link the same-page body instead (rendered by the overview), never the redirected tab.
const detailsRedirect = computed(() => Boolean(props.pkg.indexing?.detailsRedirect));
const detailsHref = computed(() =>
  detailsRedirect.value ? '#install-details' : `${localePath(packagePath(props.pkg.token, 'details'))}#requirements`
);
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
