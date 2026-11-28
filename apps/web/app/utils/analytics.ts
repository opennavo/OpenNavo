import { webRouteType } from '@opennavo/shared';

// Configured analytics starts in every region after the page is idle, unless
// the visitor has opted out. Advertising signals remain disabled.

export type ConsentChoice = 'granted' | 'denied';
export type AnalyticsEvent =
  | 'get_app'
  | 'copy_install_command'
  | 'open_in_app'
  | 'download_client'
  | 'github_outbound_click'
  | 'ai_referral_landing';

export type AnalyticsParams = Record<string, string | number | boolean | undefined>;

/** First-party first-touch record for an AI-assistant referral; no PII and no query strings. */
export interface AiFirstTouch {
  source: string;
  landing_path: string;
  timestamp: string;
}

export const AI_FIRST_TOUCH_STORAGE_KEY = 'onv_ai_first_touch';

const AI_REFERRER_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'perplexity.ai',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'deepseek.com',
  'grok.com',
  'x.ai',
  'you.com',
  'phind.com',
  'meta.ai'
] as const;

const CAMPAIGN_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_id',
  'utm_content',
  'utm_term',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic'
] as const;

export const CONSENT_STORAGE_KEY = 'onv:analytics-consent';

// pvuv.ai page analytics (hosted service). The loader is injected only after the same consent
// decision as GA4 (useAnalyticsConsent), and reads its settings from its own tag's data attributes.
// `data-spa` counts client-side navigations as page views; the excluded paths are the ones whose
// query strings carry visitor-supplied text (search terms, feedback drafts), which the SDK would
// otherwise store verbatim.
export const PVUV_SCRIPT_SRC = 'https://www.pvuv.ai/f.js';
export const PVUV_API_BASE = 'https://in.pvuv.ai';
export const PVUV_EXCLUDE = '/search*,/feedback*';
const PVUV_SCRIPT_ID = 'pvuv-analytics';
const PVUV_COOKIES = ['_pv_id', '_pv_sid', '_pv_ft', '_pv_v'];
const PVUV_STORAGE_KEYS = ['_pv_id'];

// Whether the pvuv loader is allowed to report, whether the tag was inserted, and the queue stub we
// installed. The SDK has no unload: once it executed, inserting the tag again would run it twice and
// double-count every event, so a re-accept only resumes reporting through the running instance.
let pvuvActive = false;
let pvuvLoaded = false;
let pvuvStub: ((...args: unknown[]) => void) | null = null;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    // The pvuv loader replaces this with its own function and replays `.q`, so calls made between
    // consent and the script executing are not lost.
    pvuv?: ((...args: unknown[]) => void) & { q?: unknown[][] };
  }
}

/** Analytics is enabled by default; an explicit opt-out still wins. */
export function analyticsPlan(choice: ConsentChoice | null): 'off' | 'load' {
  return choice === 'denied' ? 'off' : 'load';
}

/** The host and each parent domain, where GA may have set its first-party _ga cookies. */
export function cookieDomains(hostname: string): string[] {
  const parts = hostname.split('.');
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join('.'));
}

let activeId = '';
let currentAiTouch: AiFirstTouch | null = null;
let aiReferralSent = false;
let initialReferrer = '';
let initialLandingPath = '';
let initialSearch: string | null = null;
let initialTitle = '';
let initialLanguage = '';

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isAiFirstTouch(value: unknown): value is AiFirstTouch {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AiFirstTouch>;
  return (
    typeof record.source === 'string' && typeof record.landing_path === 'string' && typeof record.timestamp === 'string'
  );
}

/** Canonical AI-assistant host for a referrer or campaign source, or null when it is not one. */
export function classifyAiSource(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Bare hosts are accepted, but a scheme other than http(s) is not a referral. A bare host
  // may still carry a numeric port, which must not be mistaken for a scheme.
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(trimmed);
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const name = scheme[1] ?? '';
    if (!/^\d+(?:[/?#]|$)/.test(rest) && (!/^https?$/i.test(name) || !rest.startsWith('//'))) return null;
  }
  let host: string;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = url.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host) return null;
  return AI_REFERRER_HOSTS.find(candidate => host === candidate || host.endsWith(`.${candidate}`)) ?? null;
}

/** Canonical AI-assistant host for an external referrer, or null when it is not one. */
export function classifyAiReferrer(referrer: string): string | null {
  return classifyAiSource(referrer);
}

function aiSourceFromSearch(search: string): string | null {
  if (!search) return null;
  return classifyAiSource(new URLSearchParams(search).get('utm_source'));
}

/**
 * Remember the original page view before consent can run. This stays in memory only; capture()
 * persists the record once analytics is active.
 */
export function rememberInitialReferral(referrer: string, landingPath: string, search = '', title = '', language = '') {
  initialReferrer = referrer;
  initialLandingPath = landingPath;
  initialSearch = search;
  initialTitle = title;
  initialLanguage = language;
}

/** Read the stored first touch, falling back to this page's in-memory copy. */
export function readAiFirstTouch(): AiFirstTouch | null {
  if (currentAiTouch) return currentAiTouch;
  try {
    const stored = safeStorage()?.getItem(AI_FIRST_TOUCH_STORAGE_KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!isAiFirstTouch(parsed)) return null;
    currentAiTouch = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeLandingPath(value: string): string {
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      path = '/';
    }
  }
  const withoutQuery = (path.split(/[?#]/)[0] || '/').replace(/^([^/])/, '/$1');
  return withoutQuery || '/';
}

/**
 * Persist the first AI referral once. Call only after analytics consent is active: the record and
 * the landing event are both first-party analytics data.
 */
export function captureAiReferral(
  referrer = initialReferrer || (typeof document === 'undefined' ? '' : document.referrer),
  landingPath = initialLandingPath || (typeof location === 'undefined' ? '/' : location.pathname),
  search = initialSearch ?? (typeof location === 'undefined' ? '' : location.search)
): { firstTouch: AiFirstTouch; created: boolean } | null {
  const existing = readAiFirstTouch();
  if (existing) return { firstTouch: existing, created: false };
  const source = classifyAiReferrer(referrer) ?? aiSourceFromSearch(search);
  if (!source) return null;
  const firstTouch: AiFirstTouch = {
    source,
    // Query strings can contain search terms or identifiers; store the path only.
    landing_path: normalizeLandingPath(landingPath),
    timestamp: new Date().toISOString()
  };
  currentAiTouch = firstTouch;
  try {
    safeStorage()?.setItem(AI_FIRST_TOUCH_STORAGE_KEY, JSON.stringify(firstTouch));
  } catch {
    // Private browsing may refuse storage; the record still lives for this page.
  }
  return { firstTouch, created: true };
}

/** Set first-touch user properties before the first page view of the activation. */
export function setAiUserProperties(result: ReturnType<typeof captureAiReferral>) {
  if (!result || !activeId || !window.gtag) return;
  const { firstTouch } = result;
  window.gtag('set', 'user_properties', {
    ai_first_touch_source: firstTouch.source,
    ai_first_touch_landing: firstTouch.landing_path
  });
}

/**
 * Send the landing event once. The event is emitted only for a newly captured referral; a stored
 * first touch is attached to later key events instead.
 */
export function trackAiReferral(result: ReturnType<typeof captureAiReferral>) {
  if (!result) return;
  const { firstTouch, created } = result;
  if (!created || aiReferralSent) return;
  if (!activeId && !pvuvActive) return;
  aiReferralSent = true;
  const payload = {
    page_location: pageLocation(firstTouch.landing_path, initialSearch ?? ''),
    page_title: initialTitle || document.title,
    ...params(firstTouch.landing_path, initialLanguage || document.documentElement.lang),
    ai_source: firstTouch.source,
    landing_path: firstTouch.landing_path
  };
  if (activeId && window.gtag) window.gtag('event', 'ai_referral_landing', payload);
  if (pvuvActive) window.pvuv?.('event', 'ai_referral_landing', payload);
}

/** Whether a link points at the OpenNavo GitHub organization or one of its repositories. */
export function isOpenNavoGithubUrl(href: string): boolean {
  try {
    const url = new URL(href, location.href);
    return (
      (url.hostname === 'github.com' || url.hostname === 'www.github.com') &&
      (url.pathname.toLowerCase() === '/opennavo' || url.pathname.toLowerCase().startsWith('/opennavo/'))
    );
  } catch {
    return false;
  }
}

/** Track a click on an OpenNavo GitHub link; the plugin binds this to the document. */
export function trackGithubOutboundClick(target: EventTarget | null) {
  const element = target instanceof Element ? target.closest('a[href]') : null;
  if (!element) return;
  const href = element.getAttribute('href');
  if (!href || !isOpenNavoGithubUrl(href)) return;
  const url = new URL(href, location.href);
  trackEvent('github_outbound_click', { link_url: `${url.origin}${url.pathname}` });
}

export function loadGtag(id: string) {
  activeId = id;
  (window as unknown as Record<string, unknown>)[`ga-disable-${id}`] = false;
  if (window.gtag) {
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // gtag.js only accepts the arguments object itself, not an array copy.
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted'
  });
  window.gtag('js', new Date());
  window.gtag('config', id, { send_page_view: false });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
}

export function stopGtag(id: string) {
  activeId = '';
  lastPageLocation = '';
  (window as unknown as Record<string, unknown>)[`ga-disable-${id}`] = true;
  window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
  clearCookies(name => name === '_ga' || name.startsWith('_ga_'));
}

/** Delete matching first-party cookies on the host and every parent domain they may have been set on. */
function clearCookies(matches: (name: string) => boolean) {
  const names = document.cookie
    .split(';')
    .map(cookie => cookie.split('=')[0]?.trim() ?? '')
    .filter(name => name !== '' && matches(name));
  for (const name of names) {
    document.cookie = `${name}=; Max-Age=0; path=/`;
    for (const domain of cookieDomains(location.hostname))
      document.cookie = `${name}=; Max-Age=0; path=/; domain=.${domain}`;
  }
}

/** Inject the pvuv loader once; accepting consent again must not add a second, double-counting tag. */
export function loadPvuv(siteId: string) {
  if (!siteId) return;
  pvuvActive = true;
  // The loader replaces window.pvuv when it executes. Still our stub means it never ran (removed
  // before it could), so the tag may be inserted again; otherwise the running SDK is reused.
  if (pvuvLoaded && window.pvuv !== pvuvStub) return;
  if (!window.pvuv) {
    // Custom events can fire before the loader executes; the SDK reads this queue at startup and
    // replays it, so events raised between consent and execution are not lost.
    const queue: unknown[][] = [];
    pvuvStub = Object.assign((...args: unknown[]) => void queue.push(args), { q: queue });
    window.pvuv = pvuvStub;
  }
  pvuvLoaded = true;
  document.getElementById(PVUV_SCRIPT_ID)?.remove();
  const script = document.createElement('script');
  script.id = PVUV_SCRIPT_ID;
  script.defer = true;
  script.src = PVUV_SCRIPT_SRC;
  script.dataset.site = siteId;
  script.dataset.api = PVUV_API_BASE;
  script.dataset.spa = 'true';
  script.dataset.exclude = PVUV_EXCLUDE;
  document.head.append(script);
}

/**
 * Best-effort opt-out: the loader has no runtime switch, so removing the tag keeps later page
 * loads from re-inserting it, and deleting its identifiers makes a new visit start from nothing.
 */
export function stopPvuv() {
  pvuvActive = false;
  document.getElementById(PVUV_SCRIPT_ID)?.remove();
  clearCookies(name => PVUV_COOKIES.includes(name));
  try {
    for (const key of PVUV_STORAGE_KEYS) localStorage.removeItem(key);
  } catch {
    // Private browsing may refuse storage; the cookies are gone either way.
  }
}

function params(pathname = location.pathname, language = document.documentElement.lang) {
  return {
    page_type: webRouteType(pathname),
    content_language: language
  };
}

function pageLocation(pathname = location.pathname, queryString = location.search) {
  const search = new URLSearchParams(queryString);
  const campaign = new URLSearchParams();
  for (const key of CAMPAIGN_QUERY_KEYS) {
    for (const value of search.getAll(key)) campaign.append(key, value);
  }
  const query = campaign.toString();
  return `${location.origin}${pathname}${query ? `?${query}` : ''}`;
}

let lastPageLocation = '';
let initialPageViewPending = true;

function sendPageView(page: string, pathname: string, title: string, language: string) {
  if (lastPageLocation === page) return;
  // Manual page views do not update document.referrer. Without an explicit value later
  // client-side navigations inherit the original external referrer instead of the previous page.
  const referrer = lastPageLocation || initialReferrer || document.referrer || '';
  lastPageLocation = page;
  window.gtag!('event', 'page_view', {
    page_location: page,
    page_title: title,
    page_referrer: referrer,
    ...params(pathname, language)
  });
}

/** Page views are sent manually so they carry the page type; only campaign parameters are retained. */
export function trackPageView() {
  if (!activeId || !window.gtag) return;
  const current = pageLocation();
  if (initialPageViewPending) {
    initialPageViewPending = false;
    const landing = initialLandingPath ? pageLocation(initialLandingPath, initialSearch ?? '') : current;
    sendPageView(
      landing,
      initialLandingPath || location.pathname,
      initialTitle || document.title,
      initialLanguage || document.documentElement.lang
    );
    if (landing !== current) sendPageView(current, location.pathname, document.title, document.documentElement.lang);
    return;
  }
  sendPageView(current, location.pathname, document.title, document.documentElement.lang);
}

/** Key events (marked in GA4) and install-intent events. A no-op until analytics is active. */
export function trackEvent(event: AnalyticsEvent, eventParams: AnalyticsParams = {}) {
  if (!activeId && !pvuvActive) return;
  const touch = readAiFirstTouch();
  const payload = {
    ...params(),
    ...(touch ? { ai_source: touch.source } : {}),
    ...eventParams
  };
  if (activeId && window.gtag) window.gtag('event', event, payload);
  if (pvuvActive) window.pvuv?.('event', event, payload);
}
