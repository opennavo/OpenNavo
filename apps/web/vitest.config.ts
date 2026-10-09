import { defineConfig } from 'vitest/config';

// Unit tests for pure functions and composables (05 §10); page-level validation uses Playwright.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts']
  }
});
