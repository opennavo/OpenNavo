import { defineConfig } from '@playwright/test';

// Web end-to-end tests (05 §10): use a backend populated with seed-e2e data (make e2e-up, default 127.0.0.1:18082).
// The backend allows CORS only for localhost:3000, so run the web app on 3000; do not reuse an existing service and risk connecting to the wrong backend.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'pnpm dev:e2e',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 180_000
  }
});
