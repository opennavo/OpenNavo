// Deep-link navigation (05 §7.1): E2E injects window.opennavoLaunchDeepLink through addInitScript,
// simulating blur/client handoff; real unregistered protocols can hang automated browsers at system prompts and block later input.

declare global {
  interface Window {
    opennavoLaunchDeepLink?: (url: string) => void;
  }
}

export function launchDeepLink(url: string) {
  const stub = window.opennavoLaunchDeepLink;
  if (stub) {
    stub(url);
    return;
  }
  window.location.href = url;
}
