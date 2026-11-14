<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router';
import AppShell from '@/layouts/AppShell.vue';
import HermesProfileShell from '@/layouts/HermesProfileShell.vue';

// Welcome and menu-bar popovers render independently; mount the app shell only on regular pages.
const route = useRoute();
const profileWindow =
  document.documentElement.dataset.opennavoWindow === 'hermes-profile' ||
  new URLSearchParams(window.location.search).has('profile');
</script>

<template>
  <RouterView v-if="route.meta.bare" />
  <HermesProfileShell v-else-if="profileWindow" />
  <AppShell v-else />
</template>
