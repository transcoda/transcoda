import { defineConfig } from 'tsdown';

// The npm package. Inside this repo the SDK is used as TypeScript source (see `exports`);
// the published build inlines @transcoda/shared, which is not on npm, and keeps zod a dependency.
export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'build',
  tsconfig: '../../tsconfig.sdk-build.json',
  sourcemap: false,
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { alwaysBundle: [/^@transcoda\//], dts: { alwaysBundle: [/^@transcoda\//] } },
});
