import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'widget.spec.ts',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4387', browserName: 'chromium', headless: true },
  webServer: { command: 'node probe/test-host.mjs', cwd: new URL('..', import.meta.url).pathname, url: 'http://127.0.0.1:4387', reuseExistingServer: false },
  reporter: 'list',
  outputDir: './test-results',
});
