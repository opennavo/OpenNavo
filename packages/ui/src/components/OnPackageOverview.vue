<script setup lang="ts">
import type { Component } from 'vue';
import type { PackageKind } from '@opennavo/shared';
import OnAboutSection from './OnAboutSection.vue';
import OnRelatedPackages from './OnRelatedPackages.vue';
import type { OnImageVariant } from '../utils/image';
import OnCodeText from './OnCodeText.vue';
import OnInstallCommand from './OnInstallCommand.vue';
import OnKeyValueList from './OnKeyValueList.vue';
import type { OnKeyValueItem } from './OnKeyValueList.vue';
import OnScreenshotGallery from './OnScreenshotGallery.vue';
import type { OnScreenshot } from './OnScreenshotGallery.vue';

// Shared overview (08 §10.5, mockup 03, ADR-017): left screenshots → introduction → host sections (offline/latest notes) → caveats.
// Right install command → information → host monthly installs → similar apps; host supplies data/links.
export interface OnRelatedPackage {
  key: string;
  kind: PackageKind;
  token: string;
  name: string;
  src?: string | null;
  /** Stored WebP renditions of the icon (X3). */
  variants?: readonly OnImageVariant[] | null;
  accent?: string | null;
  description?: string | null;
  href: string;
}

export interface OnPackageOverviewProps {
  screenshots?: readonly OnScreenshot[];
  screenshotsLabel?: string;
  /** App name for the alternative text of screenshots without a caption. */
  screenshotsName?: string;
  /** Whether introduction exists, rendered through about slot. */
  hasAbout?: boolean;
  caveats?: string | null;
  caveatsTitle?: string;
  /** Install command; link apps have none and fill the `download` slot instead. */
  command?: string;
  /** Lifecycle explanation; a disabled notice replaces the command, others precede it. */
  installNotice?: { text: string; disabled: boolean };
  info: readonly OnKeyValueItem[];
  related?: readonly OnRelatedPackage[];
  relatedTitle?: string;
  /** Render related packages at the end of the main column instead of the side column. */
  relatedInMain?: boolean;
  relatedMoreHref?: string;
  relatedMoreLabel?: string;
  linkAs?: string | Component;
}

withDefaults(defineProps<OnPackageOverviewProps>(), {
  screenshots: () => [],
  hasAbout: false,
  related: () => [],
  linkAs: 'a'
});

const emit = defineEmits<{ copied: [command: string] }>();

defineSlots<{
  /** Top of the main column, before screenshots, e.g. the web's facts table. */
  top?: () => unknown;
  /** Markdown introduction. */
  about?: () => unknown;
  /** After introduction/before caveats, e.g. offline/latest-release cards. */
  main?: () => unknown;
  /** Top of the side column in place of the install command, e.g. link apps' download panel. */
  download?: () => unknown;
  /** Shared package specification card, rendered in the side column. */
  spec?: () => unknown;
  /** After information, e.g. monthly installs. */
  aside?: () => unknown;
  /** End of the side column, after similar apps, e.g. the collections an app is in. */
  asideEnd?: () => unknown;
}>();
</script>

<template>
  <div class="grid grid-cols-1 gap-20px pt-4px lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
    <div v-if="$slots.top" class="min-w-0 lg:col-start-1 lg:row-start-1">
      <slot name="top" />
    </div>
    <OnScreenshotGallery
      v-if="screenshots.length"
      class="min-w-0 lg:col-start-1 lg:row-start-1"
      :items="screenshots"
      :label="screenshotsLabel"
      :name="screenshotsName"
    />
    <OnAboutSection v-if="hasAbout" class="min-w-0 lg:col-start-1 lg:row-start-2">
      <slot name="about" />
    </OnAboutSection>
    <!-- PR3 mobile order: the spec card follows the description, so it stays before the side-column wrapper. -->
    <div v-if="$slots.spec" class="min-w-0 lg:col-start-2 lg:row-start-2">
      <slot name="spec" />
    </div>
    <div class="flex min-w-0 flex-col gap-14px lg:col-start-2 lg:row-start-1">
      <slot name="download" />
      <section
        v-if="command || installNotice"
        class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-14px"
        data-testid="package-install-command"
      >
        <p
          v-if="installNotice"
          role="note"
          class="m-0 rounded-default border border-solid px-12px py-10px text-12.5px leading-[1.6]"
          :class="[
            installNotice.disabled
              ? 'border-status-danger text-status-danger'
              : 'border-status-warning text-status-warning',
            command && !installNotice.disabled ? 'mb-12px' : ''
          ]"
        >
          {{ installNotice.text }}
        </p>
        <OnInstallCommand
          v-if="command && !installNotice?.disabled"
          :command="command"
          @copied="emit('copied', $event)"
        />
      </section>
    </div>
    <div class="flex min-w-0 flex-col gap-16px lg:col-start-1 lg:row-start-3">
      <slot name="main" />
      <OnRelatedPackages
        v-if="relatedInMain"
        :related="related"
        :related-title="relatedTitle"
        :related-more-href="relatedMoreHref"
        :related-more-label="relatedMoreLabel"
        :link-as="linkAs"
      />
      <section
        v-if="caveats"
        class="rounded-big border border-solid border-status-warning bg-surface-card px-18px py-14px"
      >
        <h2 class="m-0 text-13.5px font-600 text-status-warning">{{ caveatsTitle }}</h2>
        <pre class="m-0 mt-8px whitespace-pre-wrap font-mono text-12px leading-[1.6] text-ink-secondary"><OnCodeText
          :text="caveats"
        /></pre>
      </section>
    </div>
    <section
      v-if="info.length"
      class="rounded-big border border-solid border-line-subtle bg-surface-card px-16px py-4px lg:col-start-2 lg:row-start-3"
    >
      <OnKeyValueList :items="info" />
    </section>
    <div v-if="$slots.aside" class="flex min-w-0 flex-col gap-14px lg:col-start-2 lg:row-start-4">
      <slot name="aside" />
    </div>
    <div v-if="!relatedInMain" class="min-w-0 lg:col-start-2 lg:row-start-5">
      <OnRelatedPackages
        :related="related"
        :related-title="relatedTitle"
        :related-more-href="relatedMoreHref"
        :related-more-label="relatedMoreLabel"
        :link-as="linkAs"
      />
    </div>
    <div v-if="$slots.asideEnd" class="min-w-0 lg:col-start-2 lg:row-start-6">
      <slot name="asideEnd" />
    </div>
  </div>
</template>
