import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildVersion } from '@transcoda/shared';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** The commit being built: TRANSCODA_COMMIT (the image build passes it), else git, else unknown. */
function commit(): string | null {
  if (process.env.TRANSCODA_COMMIT) return process.env.TRANSCODA_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

// The same version the server reports (apps/server/tsdown.config.ts), for the error reports.
const version = buildVersion(pkg.version, {
  release: process.env.TRANSCODA_RELEASE === 'true',
  commit: commit(),
});

// Fixed non-UTC zone for all web tests so local-time conversions (token expiry) are not
// tautological on UTC machines. Set before workers fork; they inherit it. Tests only: the dev
// server and production builds keep the real zone.
if (process.env.VITEST) process.env.TZ = 'Asia/Kolkata';

// The proxy leaves Host/Origin untouched (no changeOrigin), so the server's
// same-origin check sees Origin http://localhost:5173 and a Host of the same hostname.
const apiTarget = process.env.TRANSCODA_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  define: { __TRANSCODA_VERSION__: JSON.stringify(version) },
  server: {
    proxy: {
      '/rpc': apiTarget,
      '/api': apiTarget,
    },
  },
  // Source maps are written beside the bundles without a sourceMappingURL comment, and the server
  // never serves them: it reads them to resolve the error reports' stack traces
  // (apps/server/src/http/client-errors/source-maps.ts).
  build: { outDir: 'dist', sourcemap: 'hidden' },
  test: {
    environment: 'jsdom',
    // One jsdom per worker instead of one per test file (it was ~45% of the run); each file
    // still gets its own module graph and globals.
    pool: 'vmThreads',
    passWithNoTests: true,
    setupFiles: ['src/testing/setup.ts'],
    // React Flow / editor tests render a lot of DOM. Alone they take 0.1 - 0.3 s; with the whole
    // monorepo's tests running in parallel they have taken more than 5 s. A passing test never
    // waits for this, only a hung one does.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
