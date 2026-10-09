import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Smoke tests require Prism (make mock); run separately with pnpm --filter @opennavo/api smoke.
    exclude: ['**/node_modules/**', 'tests/*.smoke.test.ts']
  }
});
