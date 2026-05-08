// E2E config. The default suite (landing.spec.ts + health.spec.ts) runs in CI
// with no extra env. The full happy-path spec (tests/e2e/happy-path.spec.ts)
// gates itself behind `RUN_FULL_E2E=1` and reads sandbox credentials at
// runtime — see tests/e2e/README.md for the operator workflow.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
