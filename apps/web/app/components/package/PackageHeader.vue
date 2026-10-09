<script setup lang="ts">
import type { PackageDetail } from '@opennavo/api';
import { architectures, OnButton, OnIcon, OnPackageHeader, useUiMessages } from '@opennavo/ui';
import type { OnPackageHeaderChip } from '@opennavo/ui';

// Detail header (08 §10.5, 03-detail): shared OnPackageHeader (ADR-017), web Get menu/homepage right.
const props = defineProps<{ pkg: PackageDetail }>();

const { t } = useI18n();
const messages = useUiMessages();

const subtitle = computed(() => [props.pkg.developer, props.pkg.summary].filter(Boolean).join(' · '));
const arch = computed(() =>
  architectures(props.pkg.supports)
    .map(item => t(`package.arch.${item}`))
    .join(' · ')
);
const unavailable = computed(() => Boolean(props.pkg.disable));

const chips = computed<OnPackageHeaderChip[]>(() => {
  const list: OnPackageHeaderChip[] = [{ key: 'kind', label: props.pkg.kind === 'cask' ? 'Cask' : 'Formula' }];
  if (props.pkg.primaryCategory) list.push({ key: 'category', label: props.pkg.primaryCategory.name });
  if (props.pkg.autoUpdates) list.push({ key: 'auto', label: t('package.autoUpdates'), tone: 'info' });
  if (arch.value) list.push({ key: 'arch', label: arch.value });
  if (props.pkg.disable) list.push({ key: 'disabled', label: t('package.disabled'), tone: 'danger', outline: true });
  else if (props.pkg.deprecation)
    list.push({ key: 'deprecated', label: t('package.deprecated'), tone: 'warning', outline: true });
  return list;
});
</script>

<template>
  <OnPackageHeader
    :kind="pkg.kind"
    :token="pkg.token"
    :name="pkg.displayName"
    :subtitle="subtitle"
    :icon-url="pkg.iconUrl"
    :accent="pkg.accentColor"
    :chips="chips"
    :meta="`${t('package.fromTap')} ${pkg.tap}`"
    priority
  >
    <template #actions>
      <OnButton v-if="unavailable" variant="primary" shape="round" icon="download" disabled>
        {{ messages.getButton.get }}
      </OnButton>
      <GetMenu
        v-else
        variant="primary"
        :kind="pkg.kind"
        :token="pkg.token"
        :name="pkg.displayName"
        :command="pkg.installCommand"
      />
      <OnButton v-if="pkg.homepage" shape="round" :href="pkg.homepage" target="_blank" rel="noopener noreferrer">
        {{ t('package.homepage') }}
        <OnIcon name="arrow-up-right" :size="15" />
      </OnButton>
    </template>
  </OnPackageHeader>
</template>
