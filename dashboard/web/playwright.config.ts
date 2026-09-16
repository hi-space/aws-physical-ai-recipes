import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 900_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
});
