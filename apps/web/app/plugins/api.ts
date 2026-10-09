import { createPublicClient } from '@opennavo/api';

// Public API client (05 §5): internal URL for SSR, public URL in browser; language follows i18n.
export default defineNuxtPlugin(nuxtApp => {
  const config = useRuntimeConfig();
  const baseUrl = import.meta.server ? config.apiBaseInternal || config.public.apiBase : config.public.apiBase;
  const api = createPublicClient({
    baseUrl,
    locale: () => toAppLocale(nuxtApp.$i18n.locale.value),
    platform: 'web',
    version: config.public.appVersion
  });
  if (import.meta.server) {
    const clientIP = useRequestEvent()?.context.publicApiClientIP;
    if (typeof clientIP === 'string') {
      api.use({
        onRequest({ request }) {
          request.headers.set('X-Forwarded-For', clientIP);
          return request;
        }
      });
    }
  }
  return { provide: { api } };
});
