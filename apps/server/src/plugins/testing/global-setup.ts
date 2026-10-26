// Vitest globalSetup: ONE build per test run (not per worker: several test files run in parallel
// workers and would race on .local/plugin-host/) of the host entry and every fixture plugin.
// Each entry is its own build so every bundle is standalone: the host runs under an fs allow-list
// of just its own file, so a shared chunk could not be imported.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'tsdown';
import { BUILD_DIR, FIXTURE_NAMES, FIXTURE_VERSION, SERVER_DIR } from './build.ts';

const SOURCES = [
  join(SERVER_DIR, 'src', 'plugin-host'),
  join(SERVER_DIR, 'src', 'plugins', 'fixtures'),
  join(SERVER_DIR, '..', '..', 'packages', 'sdk', 'src'),
  join(SERVER_DIR, '..', '..', 'packages', 'shared', 'src'),
];

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((latest, name) => Math.max(latest, newest(join(path, name))), 0);
}

const outputs = [
  join(BUILD_DIR, 'plugin-host.js'),
  ...FIXTURE_NAMES.map((n) => join(BUILD_DIR, 'fixtures', `${n}-${FIXTURE_VERSION}.js`)),
];

function upToDate(): boolean {
  if (!outputs.every((o) => existsSync(o))) return false;
  const oldest = Math.min(...outputs.map((o) => statSync(o).mtimeMs));
  return SOURCES.every((s) => newest(s) <= oldest);
}

async function bundle(entryName: string, source: string): Promise<void> {
  await build({
    cwd: SERVER_DIR,
    config: false,
    entry: { [entryName]: source },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outDir: BUILD_DIR,
    clean: false,
    dts: false,
    sourcemap: false,
    logLevel: 'error',
    deps: { alwaysBundle: [/^@transcoda\//, 'zod'] },
    outExtensions: () => ({ js: '.js' }),
  });
}

export default async function setup(): Promise<void> {
  if (upToDate()) return;
  await Promise.all([
    bundle('plugin-host', 'src/plugin-host/main.ts'),
    ...FIXTURE_NAMES.map((name) =>
      bundle(`fixtures/${name}-${FIXTURE_VERSION}`, `src/plugins/fixtures/${name}.plugin.ts`),
    ),
  ]);
}
