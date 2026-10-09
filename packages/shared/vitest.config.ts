import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // Critical functions require 100% branch coverage (09 §5).
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
});
