import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E lane.
 *
 * **No `webServer` block, deliberately.** `scripts/e2e.sh` owns the lifecycle: it
 * migrates, builds in production mode, reseeds, and starts api, sync and web
 * before Playwright runs. A second way to bring the stack up -- one without the
 * reseed -- would make the suite pass or fail depending on which one a developer
 * used. Run it with `./scripts/e2e.sh`, never `playwright test` alone.
 *
 * **Chromium and Firefox.** Firefox is the engine that reported a sibling
 * project's scrollable region as keyboard-inaccessible when Chromium's axe run
 * did not, and this suite also leans on IndexedDB, `setOffline` and websockets
 * surviving a reconnect, which is exactly where two engines differ.
 *
 * **One worker.** Every spec types into the same seeded documents, and several
 * open two contexts at once to prove convergence. A second worker typing into the
 * same document while another asserts on its text is a flake that reproduces once
 * a fortnight.
 */
const WEB_PORT = process.env.WEB_PORT ?? '3000';

export default defineConfig({
  testDir: './tests',
  // demo.spec.ts captures frames for the README GIF; scripts/demo-gif.sh turns it on.
  testIgnore: process.env.DEMO === '1' ? [] : ['**/demo.spec.ts'],
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  // One retry on CI for cold-runner jitter; none locally, where a flake should be
  // fixed rather than absorbed. The first attempt's trace is still attached.
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // JSON to a file, never stdout: scripts/a11y-baseline.sh reads it through
  // PLAYWRIGHT_JSON_OUTPUT_NAME, and on stdout it buries the failure list.
  reporter: [
    process.env.CI ? ['github'] : ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? 'test-results/report.json' }],
  ],
  outputDir: './test-results',
  use: {
    baseURL: process.env.APP_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
