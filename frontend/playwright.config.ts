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
  // Software-rendered WebGL suites share one test server and are CPU intensive.
  // Keep CI within the same resource budget as the verified local run.
  workers: 1,
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
          ADMIN_USERNAME: process.env.E2E_SETUP ? '' : 'e2e_instance_admin',
          ADMIN_PASSWORD: process.env.E2E_SETUP ? '' : 'synthetic-instance-password-2026',
          LOG_LEVEL: 'warn',
          MFA_REQUIRED_ROLES: 'admin',
          // Local browser suites represent several independent test clients.
          TRUSTED_PROXY_IPS: '127.0.0.1,::1',
          PUBLIC_ACCESS: process.env.E2E_PRIVATE ? 'false' : 'true',
          REGISTRATIONS_ENABLED: process.env.E2E_REGISTRATIONS || 'true',
        },
      },
  reporter: 'list',
});
