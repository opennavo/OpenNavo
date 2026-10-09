<script setup lang="ts">
import { BRAND } from '@opennavo/shared';

defineOptions({
  name: 'GlobalFooter'
});

const year = new Date().getFullYear();
</script>

<template>
  <DarkModeContainer class="h-full flex-center">
    <NText depth="3" class="text-12px">© {{ year }} {{ BRAND.name }}</NText>
  </DarkModeContainer>
</template>

<style scoped></style>
