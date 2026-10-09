import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { defineConfig, loadEnv } from 'vite';

// Desktop UI (06 §2): port 1420; --mode web runs in a regular browser with IPC simulated by src/ipc/mock.ts.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  const apiBase = env.VITE_API_BASE || 'http://localhost:8080/api/v1';
  return {
    // Proxy development requests through the same origin to avoid backend CORS rejection when the native window uses a fallback port.
    define: command === 'serve' ? { 'import.meta.env.VITE_API_BASE': JSON.stringify('/api/v1') } : {},
    plugins: [vue(), UnoCSS()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
    },
    clearScreen: false,
    server: {
      host: '127.0.0.1',
      port: 1420,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
      proxy: {
        '/api/v1': {
          target: apiBase,
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/v1/, ''),
          configure: proxy => {
            proxy.on('proxyReq', request => request.removeHeader('origin'));
          }
        }
      }
    },
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: {
      // Tauri 2's minimum macOS 13 uses the Safari 16 engine.
      target: 'safari16',
      outDir: 'dist',
      emptyOutDir: true
    }
  };
});
