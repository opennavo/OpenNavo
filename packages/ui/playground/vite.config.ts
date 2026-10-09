import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { defineConfig } from 'vite';

// Component playground: all variants for development and screenshot acceptance (08 §8).
export default defineConfig({
  plugins: [vue(), UnoCSS({ configFile: fileURLToPath(new URL('./uno.config.ts', import.meta.url)) })],
  server: { host: '127.0.0.1', port: 6006, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true }
});
