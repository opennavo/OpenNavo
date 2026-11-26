import {
  CONSENT_STORAGE_KEY,
  rememberInitialReferral,
  trackGithubOutboundClick,
  trackPageView
} from '~/utils/analytics';

// useHead applies the new page title and language after page:finish; a short wait lets the page view
// carry its own metadata instead of the previous page's.
const PAGE_VIEW_SETTLE_MS = 50;

// Starts configured analytics after the page is idle so it never competes with rendering; later navigations
// send their own page views.
export default defineNuxtPlugin(nuxtApp => {
  rememberInitialReferral(
    document.referrer,
    location.pathname,
    location.search,
    document.title,
    document.documentElement.lang
  );
  const consent = useAnalyticsConsent();
  let pageViewTimer: ReturnType<typeof setTimeout> | undefined;
  const changed = (event: StorageEvent) => {
    if (event.key === CONSENT_STORAGE_KEY && event.newValue === 'denied') consent.decline();
  };
  const clicked = (event: MouseEvent) => trackGithubOutboundClick(event.target);
  window.addEventListener('storage', changed);
  document.addEventListener('click', clicked);
  nuxtApp.vueApp.onUnmount(() => {
    window.removeEventListener('storage', changed);
    document.removeEventListener('click', clicked);
    clearTimeout(pageViewTimer);
  });
  nuxtApp.hook('app:mounted', () => {
    if (!consent.enabled.value) return;
    const run = () => void consent.start();
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
  });
  nuxtApp.hook('page:finish', () => {
    if (!consent.active.value) return;
    const target = `${location.pathname}${location.search}`;
    // A newer navigation replaces a pending view; the target check drops a view that is already stale.
    clearTimeout(pageViewTimer);
    pageViewTimer = setTimeout(() => {
      if (consent.active.value && `${location.pathname}${location.search}` === target) trackPageView();
    }, PAGE_VIEW_SETTLE_MS);
  });
});
