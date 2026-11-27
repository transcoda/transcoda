import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
export const STORAGE_STATE = '.local/e2e-admin.json';
const VISUAL = '3-visual.e2e.ts';
/** Set in e2e/Dockerfile: screenshots are compared only there. */
const IN_CONTAINER = process.env.TRANSCODA_E2E_CONTAINER === '1';

/**
 * Browser tests against the built server (`e2e/server.mjs`): `pnpm build && pnpm fixtures`, then
 * `pnpm e2e`. One server per run, so the specs share its state and run one after another.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries: the specs share one server's state, so a second try starts from the wrong place.
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: '.local/e2e-report' }]]
    : 'list',
  outputDir: '.local/e2e-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: 'setup.e2e.ts' },
    {
      name: 'flows',
      testIgnore: ['setup.e2e.ts', VISUAL],
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
    // Screenshots, after the flows have filled the server. Compared only in the Playwright
    // container (`pnpm e2e:docker`, CI): elsewhere fonts and rendering differ, so they are skipped.
    ...(IN_CONTAINER
      ? ([
          ['light', { ...devices['Desktop Chrome'], colorScheme: 'light' }],
          ['dark', { ...devices['Desktop Chrome'], colorScheme: 'dark' }],
          ['phone', { ...devices['Pixel 7'], colorScheme: 'light' }],
        ] as const)
      : []
    ).map(([name, use]) => ({
      name,
      testMatch: VISUAL,
      dependencies: ['flows'],
      use: { ...use, storageState: STORAGE_STATE },
    })),
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://localhost:${PORT}/api/v1/system/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
