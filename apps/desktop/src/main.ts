import { createApp, computed } from 'vue';
import { createPinia } from 'pinia';
import { isTauri } from '@tauri-apps/api/core';
import '@unocss/reset/tailwind.css';
import '@opennavo/tokens/tokens.css';
import '@opennavo/ui/base.css';
import '@opennavo/ui/system-fonts.css';
import 'virtual:uno.css';
import { createOnUi } from '@opennavo/ui';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import { deepLinkOpened, resumeDeepLink, startDeepLinks } from './composables/useDeepLink';
import { startAppLocale } from './composables/startAppLocale';
import { syncMainWindow } from './composables/syncMainWindow';
import { startupRedirect } from './composables/startupRoute';
import { startGuideState, startLocalState, startTrayState, useSettingsStore } from './stores';

// Regular browsers (pnpm dev:web) have no Tauri runtime; simulate IPC with fixtures (06 §16).
if (!isTauri()) {
  const { installMockIpc } = await import('./ipc/mock');
  installMockIpc();
}

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);
app.use(createOnUi({ locale: computed(() => i18n.global.locale.value) }));
await startAppLocale();
if (location.hash.startsWith('#/tray')) {
  document.documentElement.dataset.opennavoWindow = 'tray';
  // Menu-bar popover: read only state allowed by the tray capability (06 §4.2, §14).
  await startTrayState();
} else if (location.hash.startsWith('#/permission-guide')) {
  document.documentElement.dataset.opennavoWindow = 'guide';
  // Permission guidance overlay: read only permissions and language allowed by the guide capability (06 §12.7, §14).
  await startGuideState();
} else {
  // Subscribe to Rust events and load local state before mounting; subscribe to deep links alongside local state to receive buffered cold-start links.
  const localState = startLocalState();
  await startDeepLinks(router, localState);
  await localState;
  // Keep navigation on Welcome until onboarding completes, then replay deferred deep links.
  router.beforeEach(to => {
    if (useSettingsStore().value?.onboardingCompleted === false && to.name !== 'welcome') return '/welcome';
  });
  const redirect = startupRedirect({
    deepLinkOpened: deepLinkOpened(),
    onboardingCompleted: useSettingsStore().value?.onboardingCompleted
  });
  if (redirect) await router.replace(redirect);
  else if (!deepLinkOpened()) await resumeDeepLink(router);
  await router.isReady();
  await syncMainWindow(router.currentRoute.value.name === 'welcome');
  router.beforeResolve(async to => {
    await syncMainWindow(to.name === 'welcome');
  });
}
app.mount('#app');
