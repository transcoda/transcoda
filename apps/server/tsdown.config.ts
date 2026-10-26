import { readFileSync } from 'node:fs';
import { defineConfig, type UserConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const base = {
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // dist also holds tsc -b declaration output; only replace our own file.
  clean: false,
  dts: false,
  sourcemap: false,
  outExtensions: () => ({ js: '.js' }),
} satisfies UserConfig;

// A plugin bundle and the host run under a permission allow-list that excludes
// /app/node_modules, so zod and the workspace packages are inlined; only `node:` stays external.
const standalone = { deps: { alwaysBundle: [/^@transcoda\//, 'zod'] } } satisfies UserConfig;

export default defineConfig([
  {
    ...base,
    name: 'server',
    entry: { main: 'src/main.ts' },
    // Workspace packages ship TypeScript source, so inline them; everything else is a
    // declared dependency resolved from node_modules at runtime.
    deps: { alwaysBundle: [/^@transcoda\//] },
    define: { 'process.env.TRANSCODA_VERSION': JSON.stringify(pkg.version) },
  },
  // `pnpm build:host` builds just this one (see package.json) for `pnpm dev`.
  { ...base, ...standalone, name: 'host', entry: { 'plugin-host': 'src/plugin-host/main.ts' } },
  // The image's sandbox job (Task 14) runs the denial suite against the built host.
  ...(process.env.TRANSCODA_BUILD_FIXTURES === '1'
    ? [
        {
          ...base,
          ...standalone,
          name: 'fixtures',
          entry: { 'fixtures/denial-0.1.0': 'src/plugins/fixtures/denial.plugin.ts' },
        } satisfies UserConfig,
      ]
    : []),
]);
