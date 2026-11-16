import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:4174';
const dataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'cswatch-e2e-'));
if (!process.env.E2E_EXISTING_SERVER) process.env.E2E_DATA_DIR = dataDir;
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: false,
  use: {
    baseURL,
    locale: 'en-GB',
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: process.env.E2E_EXISTING_SERVER
    ? undefined
    : {
        command: 'node ../backend/dist/server.js',
        url: baseURL + '/api/health',
        reuseExistingServer: false,
        env: {
          APP_URL: baseURL,
          PORT: new URL(baseURL).port,
          COOKIE_SECURE: 'false',
          DATA_DIR: dataDir,
          LOG_LEVEL: 'warn',
          PUBLIC_ACCESS: process.env.E2E_PRIVATE ? 'false' : 'true',
          REGISTRATIONS_ENABLED: process.env.E2E_REGISTRATIONS || 'true',
        },
      },
  reporter: 'list',
});
