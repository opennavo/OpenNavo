/**
 * Startup destination (first-launch-onboarding §3.1, D1): deep links cannot bypass incomplete onboarding.
 * Show Welcome while initial onboarding is incomplete; otherwise keep the default page, even without Homebrew.
 */
export function startupRedirect(state: { deepLinkOpened: boolean; onboardingCompleted?: boolean }): string | null {
  // Do not redirect before settings load, to avoid sending existing users back to onboarding.
  return state.onboardingCompleted === false ? '/welcome' : null;
}
