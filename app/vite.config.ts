import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// TAURI_DEV_HOST is set by `tauri ios dev` so a phone can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // CalVer label from scripts/set-version.mjs (CI); "dev" for local builds.
  define: { __APP_VERSION__: JSON.stringify(process.env.NEXTLY_VERSION_LABEL || 'dev') },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
  },
  build: { target: 'safari15', outDir: 'dist' },
});
