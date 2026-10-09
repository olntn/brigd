import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: {
    command: 'bun server/index.ts',
    url: 'http://127.0.0.1:4318/api/info',
    reuseExistingServer: false,
    env: { PORT: '4318', BRIGD_MODE: 'mock', BRIGD_DB: 'test-results/browser.sqlite', BRIGD_HOST: '127.0.0.1', BRIGD_ALLOWED_HOSTS: '127.0.0.1:4318,localhost:4318', BRIGD_ALLOWED_ORIGINS: 'http://127.0.0.1:4318,http://localhost:4318', BRIGD_DEV: '0' },
    timeout: 15_000,
  },
});
