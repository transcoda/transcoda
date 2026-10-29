// Tests only: where global-setup.ts put the built host and fixture plugins.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_NAMES = [
  'example',
  'denial',
  'spin',
  'hog',
  'crash',
  'leaky',
  'secrets',
  'badexport',
  'fetcher',
  'setupfail',
  'ctxprobe',
  'versioned',
  'versioned2',
  'roots',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const FIXTURE_VERSION = '0.1.0';

/** apps/server */
export const SERVER_DIR = fileURLToPath(new URL('../../../', import.meta.url));
export const BUILD_DIR = join(SERVER_DIR, '.local', 'plugin-host');

function built(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing: run the server vitest project (globalSetup builds the host)`,
    );
  }
  return path;
}

export function hostPath(): string {
  return built(join(BUILD_DIR, 'plugin-host.js'));
}

export function fixturePluginPath(name: FixtureName): string {
  return built(join(BUILD_DIR, 'fixtures', `${name}-${FIXTURE_VERSION}.js`));
}
