<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router';
import AppShell from '@/layouts/AppShell.vue';

// Welcome and menu-bar popovers render independently; mount the app shell only on regular pages.
const route = useRoute();
</script>

<template>
  <RouterView v-if="route.meta.bare" />
  <AppShell v-else />
</template>
