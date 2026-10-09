import { defineConfig } from '@playwright/test';

// Admin end-to-end tests (07 §9). Use locally installed Chrome; CI uses Playwright's bundled Chromium.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:9527',
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 },
    // Cases explicitly exercise the Chinese UI; the admin selects its language from the browser, while CI Chromium defaults to English.
    locale: 'zh-CN',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:9527',
    reuseExistingServer: !process.env.CI,
    // Menu cases intercept API calls in the browser; full-stack cases (stack.spec.ts) reach the E2E stack through Vite's proxy.
    env: {
      BROWSER: 'none',
      VITE_SERVICE_BASE_URL: process.env.VITE_SERVICE_BASE_URL ?? 'http://127.0.0.1:18082/admin-api'
    },
    timeout: 120_000
  }
});
