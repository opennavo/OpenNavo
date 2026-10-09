// Two runtime site variables (05 §9): NUXT_PUBLIC_SITE_URL for share images/sitemaps/robots,
// and NUXT_PUBLIC_I18N_BASE_URL for canonical/hreflang. Warn at startup if only one is set, avoiding mixed domains.
export default defineNitroPlugin(() => {
  if (import.meta.dev) return;
  const { siteUrl, i18n } = useRuntimeConfig().public;
  const i18nBaseUrl = (i18n as { baseUrl?: string } | undefined)?.baseUrl;
  if (siteUrl !== i18nBaseUrl) {
    console.error(
      `[opennavo] NUXT_PUBLIC_I18N_BASE_URL (${i18nBaseUrl}) differs from NUXT_PUBLIC_SITE_URL (${siteUrl}); canonical and hreflang will point to the wrong domain`
    );
  }
});
