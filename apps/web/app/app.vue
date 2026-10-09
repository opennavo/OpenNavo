<script setup lang="ts">
// i18n generates html lang and hreflang (05 §6.1).
// Canonical URLs remove query parameters except page (05 §6.1).
const { locale } = useI18n();
const head = useLocaleHead({ seo: { canonicalQueries: ['page'] } });
useHead(() => ({
  htmlAttrs: { lang: head.value.htmlAttrs.lang },
  link: [...(head.value.link ?? [])],
  meta: [
    ...(head.value.meta ?? []).filter(tag => tag.property !== 'og:locale'),
    { property: 'og:locale', content: toAppLocale(locale.value).replace('-', '_') }
  ]
}));
// Titles already include the brand (05 §6.1); override Nuxt SEO's lower-priority default template to avoid appending the site name again.
useHead({ titleTemplate: '%s' }, { tagPriority: 'high' });
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
