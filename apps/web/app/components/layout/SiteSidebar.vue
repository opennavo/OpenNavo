<script setup lang="ts">
import { OnLogo, OnSidebar, useUiMessages } from '@opennavo/ui';

// Web sidebar (05 §11.2): shared OnSidebar (ADR-017); top card downloads the client.
const { t } = useI18n();
const localePath = useLocalePath();
const messages = useUiMessages();
const { groups, footer } = useSiteNav();
const NuxtLink = resolveComponent('NuxtLink');
</script>

<template>
  <OnSidebar
    :groups="groups"
    :footer-items="footer"
    :label="t('nav.label')"
    :top-label="t('sidebar.appLabel')"
    :link-as="NuxtLink"
  >
    <template #brand>
      <NuxtLink
        :to="localePath('/')"
        class="inline-flex rounded-tiny no-underline outline-none focus-visible:shadow-focus-ring"
        :aria-label="messages.topNav.home"
      >
        <OnLogo wordmark />
      </NuxtLink>
    </template>
    <template #top>
      <DownloadCard />
    </template>
  </OnSidebar>
</template>
