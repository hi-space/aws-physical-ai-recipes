import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 900_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    // The dashboard negotiates its UI language from Accept-Language; the specs assert the Korean copy.
    locale: 'ko-KR',
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
  },
});
