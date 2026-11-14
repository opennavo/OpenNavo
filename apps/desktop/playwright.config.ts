import { defineConfig } from '@playwright/test';

// Desktop end-to-end tests against the browser-mode build with the IPC mocks
// (`vite --mode web`), so no Tauri runtime is needed. Use locally installed Chrome;
// CI uses Playwright's bundled Chromium.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:1422',
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure'
  },
  webServer: {
    // 1422 keeps the tests off a developer's running dev server on 1420.
    command: 'pnpm exec vite --mode web --port 1422 --strictPort',
    url: 'http://127.0.0.1:1422',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
