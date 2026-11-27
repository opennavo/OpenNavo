import {
  CONSENT_STORAGE_KEY,
  analyticsPlan,
  captureAiReferral,
  loadGtag,
  loadPvuv,
  setAiUserProperties,
  stopGtag,
  stopPvuv,
  trackAiReferral,
  trackPageView
} from '~/utils/analytics';
import type { ConsentChoice } from '~/utils/analytics';

// Site ids from the pvuv console are short alphanumerics; anything else counts as "not configured"
// so a typo cannot put a wrong id on every page.
const PVUV_SITE_ID = /^[A-Za-z0-9]{4,16}$/;

// GA4 and pvuv share the banner, footer settings and stored choice.
export function useAnalyticsConsent() {
  const settings = useSiteSettings();
  const banner = useState('analytics:banner', () => false);
  const active = useState('analytics:active', () => false);
  const measurementId = computed(() => {
    const analytics = settings.value?.analytics;
    return analytics?.ga4Enabled && analytics.ga4MeasurementId ? analytics.ga4MeasurementId : '';
  });
  // Deployment-specific: NUXT_PUBLIC_PVUV_SITE_ID overrides the default in nuxt.config. Local
  // development never reports to the hosted service, matching the first-party usage plugin.
  const pvuvSiteId = computed(() => {
    if (import.meta.dev) return '';
    const configured = String(useRuntimeConfig().public.pvuvSiteId ?? '').trim();
    return PVUV_SITE_ID.test(configured) ? configured : '';
  });

  const enabled = computed(() => Boolean(measurementId.value || pvuvSiteId.value));

  function storedChoice(): ConsentChoice | null {
    try {
      const value = localStorage.getItem(CONSENT_STORAGE_KEY);
      return value === 'granted' || value === 'denied' ? value : null;
    } catch {
      return null;
    }
  }

  function remember(choice: ConsentChoice) {
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, choice);
    } catch {
      // Private browsing may refuse storage; the choice then lasts for this page only.
    }
  }

  function activate() {
    if (!enabled.value) return;
    if (measurementId.value) loadGtag(measurementId.value);
    if (pvuvSiteId.value) loadPvuv(pvuvSiteId.value);
    active.value = true;
    const referral = captureAiReferral();
    setAiUserProperties(referral);
    trackPageView();
    trackAiReferral(referral);
  }

  async function start() {
    if (!enabled.value) return;
    // Analytics starts in every region without a permission prompt. The footer
    // still lets visitors opt out, and a saved opt-out remains effective.
    if (analyticsPlan(storedChoice()) === 'load') activate();
  }

  function accept() {
    remember('granted');
    banner.value = false;
    activate();
  }

  function decline() {
    remember('denied');
    banner.value = false;
    active.value = false;
    if (measurementId.value) stopGtag(measurementId.value);
    stopPvuv();
  }

  return {
    banner,
    active,
    enabled,
    start,
    accept,
    decline,
    openSettings: () => (banner.value = true)
  };
}
