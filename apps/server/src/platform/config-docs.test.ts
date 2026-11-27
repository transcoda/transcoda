// docs/env.md lists the environment variables by hand. This test keeps its tables in step with the
// variables loadConfig() reads, so a new or renamed variable fails here, not in someone's compose file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const CONFIG = readFileSync(root('apps/server/src/platform/config.ts'), 'utf8');
const DOCS = readFileSync(root('docs/env.md'), 'utf8');

/** Read by config.ts but described in another variable's row or in the text, not a row of their own. */
const IN_TEXT: Record<string, string> = {
  NODE_ENV: 'the standard Node variable; the rows that depend on it name `NODE_ENV=production`',
  TRANSCODA_DECODE_MEMORY_GIB: 'the older binary name, in the TRANSCODA_DECODE_MEMORY_GB row',
  TRANSCODA_HEALTH_MIN_FREE_GIB: 'the older binary name, in the TRANSCODA_HEALTH_MIN_FREE_GB row',
};

/** Rows for variables that something other than the server's config reads. */
const NOT_CONFIG: Record<string, string> = {
  UMASK: 'docker/entrypoint.sh',
  PLUGIN_UID: 'docker/entrypoint.sh, passed on as TRANSCODA_PLUGIN_UID',
  PLUGIN_GID: 'docker/entrypoint.sh, passed on as TRANSCODA_PLUGIN_GID',
  TRANSCODA_CHOWN_CONFIG: 'docker/entrypoint.sh',
  TZ: 'the Node runtime',
  TRANSCODA_VERSION: 'the server build (tsdown)',
  TRANSCODA_BUILD_FIXTURES: 'the server build',
  TRANSCODA_API_URL: 'the web dev server (Vite)',
};

/** Every variable config.ts reads (`env.NAME`). */
function readByConfig(): Set<string> {
  return new Set([...CONFIG.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1] ?? ''));
}

/** Every variable named in the first cell of a table row in docs/env.md. */
function documentedRows(): Set<string> {
  const names = DOCS.split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => {
      const cell = line.split('|')[1] ?? '';
      return [...cell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1] ?? '');
    });
  return new Set(names);
}

describe('docs/env.md', () => {
  const read = readByConfig();
  const rows = documentedRows();

  it('finds the variables on both sides', () => {
    expect(read.size).toBeGreaterThan(30);
    expect(rows.size).toBeGreaterThan(30);
  });

  it('has a row for every variable config.ts reads', () => {
    const missing = [...read].filter((name) => !rows.has(name) && !(name in IN_TEXT));
    expect(missing, 'add a row to docs/env.md').toEqual([]);
  });

  it('mentions the variables that have no row of their own', () => {
    for (const name of Object.keys(IN_TEXT)) {
      expect(read.has(name), `${name} is no longer read: drop it from IN_TEXT`).toBe(true);
      expect(DOCS, `docs/env.md never names ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('documents no variable that nothing reads', () => {
    const stale = [...rows].filter((name) => !read.has(name) && !(name in NOT_CONFIG));
    expect(stale, 'drop the row from docs/env.md, or say in NOT_CONFIG what reads it').toEqual([]);
  });
});
