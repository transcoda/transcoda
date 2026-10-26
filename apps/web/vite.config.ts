import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Fixed non-UTC zone for all web tests so local-time conversions (token expiry) are not
// tautological on UTC machines. Set before workers fork; they inherit it. Tests only: the dev
// server and production builds keep the real zone.
if (process.env.VITEST) process.env.TZ = 'Asia/Kolkata';

// The proxy leaves Host/Origin untouched (no changeOrigin), so the server's
// same-origin check sees Origin http://localhost:5173 and a Host of the same hostname.
const apiTarget = process.env.TRANSCODA_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/rpc': apiTarget,
      '/api': apiTarget,
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'jsdom',
    // One jsdom per worker instead of one per test file (it was ~45% of the run); each file
    // still gets its own module graph and globals.
    pool: 'vmThreads',
    passWithNoTests: true,
    setupFiles: ['src/test/setup.ts'],
    // React Flow / editor tests render a lot of DOM. Alone they take 0.1 - 0.3 s; with the whole
    // monorepo's tests running in parallel they have taken more than 5 s. A passing test never
    // waits for this, only a hung one does.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
