import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One host + fixture build per run, shared by every worker (see global-setup.ts).
    globalSetup: ['src/plugins/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
