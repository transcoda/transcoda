// docs/env.md's "Settings in the database" table lists the settings rows by hand. This test keeps
// its keys and defaults in step with SETTING_KEYS and SETTING_DEFAULTS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, SETTING_KEYS } from '../db/repos/settings.ts';

const DOCS = readFileSync(
  fileURLToPath(new URL('../../../../docs/env.md', import.meta.url)),
  'utf8',
);

/** The table's rows as key → default cell. */
function tableRows(): Map<string, string> {
  const start = DOCS.indexOf('\n## Settings in the database\n');
  const end = DOCS.indexOf('\n## ', start + 1);
  const rows = new Map<string, string>();
  for (const line of DOCS.slice(start, end).split('\n')) {
    const m = /^\| `([^`]+)` \| ([^|]+) \|/.exec(line);
    if (m?.[1] && m[2]) rows.set(m[1], m[2].trim());
  }
  return rows;
}

/** How the default cell starts for a value: the literal in backticks, `none` or `empty`. */
function shown(value: unknown): string {
  if (value === null) return 'none';
  if (Array.isArray(value) && value.length === 0) return 'empty';
  return `\`${String(value)}\``;
}

describe('docs/env.md settings table', () => {
  const rows = tableRows();
  const keys = Object.entries(SETTING_KEYS) as [keyof typeof SETTING_KEYS, string][];

  it('has a row for every setting key, and no other', () => {
    expect([...rows.keys()].sort()).toEqual(keys.map(([, key]) => key).sort());
  });

  it('gives each setting its default', () => {
    for (const [name, key] of keys) {
      expect(rows.get(key), key).toMatch(new RegExp(`^${shown(SETTING_DEFAULTS[name])}`));
    }
  });
});
