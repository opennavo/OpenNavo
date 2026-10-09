<script setup lang="ts">
// Footer sits below main content/rail in the shell column, with matching horizontal padding.
const { t } = useI18n();
const year = new Date().getFullYear();
</script>

<template>
  <footer class="flex flex-col gap-6px border-t border-t-solid border-line-subtle px-16px py-24px md:px-28px">
    <p class="m-0 text-13px text-ink-secondary">{{ t('footer.tagline') }}</p>
    <p class="m-0 text-12px text-ink-tertiary">{{ t('footer.copyright', { year }) }}</p>
  </footer>
</template>
