// Shared by web, desktop, and shared packages; admin uses its own upstream configuration in apps/admin.
import { defineConfig } from '@soybeanjs/eslint-config-vue';

export default [
  {
    ignores: [
      'apps/admin/**',
      '**/src-tauri/**',
      'apps/server/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**'
    ]
  },
  ...(await defineConfig({
    '@typescript-eslint/no-explicit-any': 'error',
    // Optional TS props already default to undefined; explicit defaults are unnecessary.
    'vue/require-default-prop': 'off',
    // Let oxfmt format templates, preserving inline whitespace according to CSS rules; disable conflicting style rules.
    'vue/html-indent': 'off',
    'vue/html-closing-bracket-newline': 'off',
    'vue/multiline-html-element-content-newline': 'off',
    'vue/singleline-html-element-content-newline': 'off'
  }))
];
