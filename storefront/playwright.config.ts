import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const API = process.env.API_PORT || '3400', WEB = process.env.VITE_PORT || '5174';
// CI installs Playwright's own Chromium; locally an already installed one can be reused via PW_CHROMIUM.
const exe = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
export default defineConfig({
  testDir: 'e2e', timeout: 30_000, retries: process.env.CI ? 1 : 0, workers: 1, reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${WEB}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: exe ? { executablePath: exe, args: ['--no-sandbox'] } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: exe ? { executablePath: exe, args: ['--no-sandbox'] } : {} } }, { name: 'mobile', use: { viewport: { width: 390, height: 800 }, isMobile: true, launchOptions: exe ? { executablePath: exe, args: ['--no-sandbox'] } : {} } }],
  webServer: [
    { command: 'node e2e/backend.mjs', url: `http://localhost:${API}/api/health`, timeout: 60_000, reuseExistingServer: false, env: { API_PORT: API } },
    { command: `npx vite --port ${WEB} --strictPort`, url: `http://localhost:${WEB}`, timeout: 60_000, reuseExistingServer: false, env: { API_PORT: API, VITE_PORT: WEB } }
  ]
});
