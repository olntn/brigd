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
    env: { PORT: '4318', TRACKT_MODE: 'mock', TRACKT_DB: 'test-results/browser.sqlite' },
    timeout: 15_000,
  },
});
