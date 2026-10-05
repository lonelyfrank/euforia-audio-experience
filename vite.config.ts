import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and must not have the console cleared.
// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
// Cross-origin isolation lets the microphone worklet share its PCM ring with the
// analysis worker (SharedArrayBuffer). Browser development only: the desktop build
// captures natively. `credentialless` isolates Chromium and Firefox without
// blocking anything; WebKit (a Tauri webview pointed at this server) ignores it and
// the analysis falls back to a MessagePort.
const isolation = process.env.TAURI_ENV_PLATFORM
  ? undefined
  : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/native/**'] },
    headers: isolation,
  },
  preview: { headers: isolation },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
  build: {
    target: 'es2022',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1000,
  },
});
