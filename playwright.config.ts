import { defineConfig } from '@playwright/test';
const port = Number(process.env.PRETHINK_TEST_PORT || 5194);
export default defineConfig({
  testDir: './tests', testMatch: 'prethink.spec.ts', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, launchOptions: { args: ['--no-sandbox'] } },
  webServer: {
    command: 'node server/prethink-server.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    env: { PORT: String(port), DEEPSEEK_API_KEY: '' },
    reuseExistingServer: false,
  },
});
