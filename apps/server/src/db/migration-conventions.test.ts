// Guard test for the migration conventions (docs/dev/conventions.md): one file per
// migration named NNNN_snake_case.ts, numbered 1..N without gaps, registered in index.ts in order
// with a matching version and name, and each with its own NNNN_*.test.ts.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrations } from './migrations/index.ts';

const DIR = join(import.meta.dirname, 'migrations');
const MIGRATION_FILE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/;
const TEST_FILE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.test\.ts$/;

/**
 * Migrations without their own test file. 1-4 predate the convention and are covered by the
 * repository and migrate tests; 12 only adds a table the plugins repository tests exercise.
 * Do not add to this list: a new migration comes with a test.
 */
const UNTESTED = new Set(['0001', '0002', '0003', '0004', '0012']);

const files = readdirSync(DIR);
const migrationFiles = files.filter((f) => MIGRATION_FILE.test(f) && !TEST_FILE.test(f)).sort();

describe('migration conventions', () => {
  it('holds only NNNN_snake_case.ts migrations, their tests and index.ts', () => {
    const stray = files.filter(
      (f) => f !== 'index.ts' && !MIGRATION_FILE.test(f) && !TEST_FILE.test(f),
    );
    expect(
      stray,
      'migration files are named NNNN_snake_case.ts (tests NNNN_snake_case.test.ts)',
    ).toEqual([]);
  });

  it('numbers the files 1..N without gaps or duplicates', () => {
    const numbers = migrationFiles.map((f) => Number(f.slice(0, 4)));
    expect(numbers, 'migration numbers must run 1..N without gaps or duplicates').toEqual(
      numbers.map((_, i) => i + 1),
    );
  });

  it('registers every file in index.ts, in order, with a matching version and name', () => {
    const registered = migrations.map((m) => `${m.version} ${m.name}`);
    const onDisk = migrationFiles.map((f) => `${Number(f.slice(0, 4))} ${f.replace(/\.ts$/, '')}`);
    expect(
      registered,
      'each migration file is listed in migrations/index.ts in order, with version = its number and name = its file name',
    ).toEqual(onDisk);
  });

  it('gives each migration its own test file', () => {
    const tested = new Set(files.filter((f) => TEST_FILE.test(f)).map((f) => f.slice(0, 4)));
    const missing = migrationFiles
      .map((f) => f.slice(0, 4))
      .filter((n) => !tested.has(n) && !UNTESTED.has(n));
    expect(missing, 'a new migration needs its own NNNN_name.test.ts next to it').toEqual([]);
    const stale = [...UNTESTED].filter((n) => tested.has(n));
    expect(stale, 'these migrations have a test now: remove them from UNTESTED').toEqual([]);
  });
});
