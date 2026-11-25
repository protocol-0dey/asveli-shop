import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// dev: the API runs on :3000; proxying keeps requests same-origin (no CORS setup needed locally)
export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.VITE_PORT) || 5173, proxy: Object.fromEntries(['^/api/', '^/f/', '^/s/'].map(k => [k, `http://localhost:${process.env.API_PORT || 3000}`])) },
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'], css: false },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 }
});
