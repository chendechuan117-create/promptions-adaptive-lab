import { defineConfig } from '@playwright/test';
const port = Number(process.env.LIVE_PROBE_TEST_PORT || 4388);
export default defineConfig({
  testDir: './tests', testMatch: ['live-widget.spec.ts', 'bridge-errors.spec.ts'], fullyParallel: true,
  timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', headless: true },
  webServer: {
    command: 'node probe/live-test-host.mjs', cwd: new URL('..', import.meta.url).pathname,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
  },
  reporter: 'list', outputDir: './live-test-results',
});
