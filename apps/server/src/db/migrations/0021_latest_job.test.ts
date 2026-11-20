import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FINAL_JOB_STATES, type JobState } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.ts';
import { closeDatabase, type Database, openDatabase } from '../open.ts';
import { insertJob, updateJob } from '../repos/jobs.ts';
import { createTestDb } from '../test-db.ts';
import { migrations } from './index.ts';

const T = '2026-01-01T00:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T) + min * 60_000);
const FINAL = new Set<string>(FINAL_JOB_STATES);

function seedBase(db: Database): void {
  db.prepare(
    `INSERT INTO workflows (id, kind, name, current_version, created_at, updated_at)
     VALUES ('w1', 'workflow', 'Shrink', 1, ?, ?)`,
  ).run(T, T);
  db.prepare(
    `INSERT INTO libraries (id, name, path, created_at, updated_at)
     VALUES ('l1', 'Lib', '/media', ?, ?)`,
  ).run(T, T);
  db.prepare(
    `INSERT INTO runs (id, library_id, workflow_id, workflow_version, requested_path, dry_run, force, created_by, created_at)
     VALUES ('r1', 'l1', 'w1', 1, '/media', 0, 0, 'u', ?)`,
  ).run(T);
}

function addFile(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO files (id, library_id, path, size_bytes, mtime_ms, ino, dev, fingerprint, updated_at)
     VALUES (?, 'l1', ?, 1, 1, 1, 1, 'k', ?)`,
  ).run(id, `/media/${id}.mkv`, T);
}

/** A job as raw SQL (the schema before 21 has no repo-shaped insert for every column). */
function rawJob(
  db: Database,
  id: string,
  fileId: string | null,
  o: { state: JobState; dryRun?: boolean; queuedAt: number },
): void {
  const ts = at(o.queuedAt).toISOString();
  db.prepare(
    `INSERT INTO jobs (id, run_id, library_id, file_id, path, workflow_id, workflow_version, dry_run,
       state, queued_at, finished_at, updated_at)
     VALUES (?, 'r1', 'l1', ?, '/media/x.mkv', 'w1', 1, ?, ?, ?, ?, ?)`,
  ).run(id, fileId, o.dryRun ? 1 : 0, o.state, ts, FINAL.has(o.state) ? ts : null, ts);
}

/** The rule as the library listing ranked it before 21 (a window over every job). */
function windowLatest(db: Database): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT file_id, id FROM (
         SELECT j.file_id, j.id, ROW_NUMBER() OVER (PARTITION BY j.file_id ORDER BY
           (j.dry_run = 0 AND j.state NOT IN ('skipped','already_processed','cancelled')) DESC,
           j.queued_at DESC, j.rowid DESC) AS rn
         FROM jobs j JOIN files f ON f.id = j.file_id
       ) WHERE rn = 1`,
    )
    .all() as { file_id: string; id: string }[];
  return Object.fromEntries(rows.map((r) => [r.file_id, r.id]));
}

function stored(db: Database): Record<string, string | null> {
  const rows = db.prepare('SELECT id, latest_job_id FROM files ORDER BY id').all() as {
    id: string;
    latest_job_id: string | null;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.latest_job_id]));
}

const latestOf = (db: Database, fileId: string): string | null =>
  (
    db.prepare('SELECT latest_job_id FROM files WHERE id = ?').get(fileId) as {
      latest_job_id: string | null;
    }
  ).latest_job_id;

describe('migration 0021', () => {
  let dir: string;
  let backupDir: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoda-0021-'));
    backupDir = path.join(dir, 'backups');
    db = openDatabase(path.join(dir, 'app.sqlite'));
    migrate(db, migrations.slice(0, 20), { backupDir });
    seedBase(db);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfills each file’s latest job by the listing’s rule, NULL for a file with none', () => {
    // real: a newer dry run, skipped, already_processed and cancelled job do not beat a real one.
    addFile(db, 'real');
    rawJob(db, 'real-done', 'real', { state: 'done', queuedAt: 1 });
    rawJob(db, 'real-dry', 'real', { state: 'dry_run', dryRun: true, queuedAt: 2 });
    rawJob(db, 'real-skip', 'real', { state: 'skipped', queuedAt: 3 });
    rawJob(db, 'real-ap', 'real', { state: 'already_processed', queuedAt: 4 });
    rawJob(db, 'real-cancel', 'real', { state: 'cancelled', queuedAt: 5 });
    // fallback: no job counts, so the newest of any kind.
    addFile(db, 'fallback');
    rawJob(db, 'fb-dry', 'fallback', { state: 'dry_run', dryRun: true, queuedAt: 1 });
    rawJob(db, 'fb-skip', 'fallback', { state: 'skipped', queuedAt: 2 });
    // active: a queued real job counts.
    addFile(db, 'active');
    rawJob(db, 'act-done', 'active', { state: 'done', queuedAt: 1 });
    rawJob(db, 'act-queued', 'active', { state: 'queued', queuedAt: 2 });
    // tie: same queued_at, the later inserted (higher rowid) wins.
    addFile(db, 'tie');
    rawJob(db, 'tie-b', 'tie', { state: 'failed', queuedAt: 1 });
    rawJob(db, 'tie-a', 'tie', { state: 'done', queuedAt: 1 });
    // older: inserted out of order, the newer queued_at wins.
    addFile(db, 'older');
    rawJob(db, 'old-new', 'older', { state: 'done', queuedAt: 9 });
    rawJob(db, 'old-old', 'older', { state: 'done', queuedAt: 1 });
    addFile(db, 'none');
    // A skipped job with no file touches nothing.
    rawJob(db, 'orphan', null, { state: 'skipped', queuedAt: 1 });

    const before = windowLatest(db);
    expect(migrate(db, migrations.slice(0, 21), { backupDir }).applied).toEqual([
      '0021_latest_job',
    ]);
    expect(stored(db)).toEqual({
      active: 'act-queued',
      fallback: 'fb-skip',
      none: null,
      older: 'old-new',
      real: 'real-done',
      tie: 'tie-a',
    });
    expect(stored(db)).toEqual({ ...before, none: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the column is nullable and existing file rows keep their data', () => {
    addFile(db, 'f1');
    const row = db.prepare("SELECT * FROM files WHERE id = 'f1'").get();
    migrate(db, migrations.slice(0, 21), { backupDir });
    expect(db.prepare("SELECT * FROM files WHERE id = 'f1'").get()).toEqual({
      ...(row as object),
      latest_job_id: null,
    });
    const col = (
      db.prepare('PRAGMA table_info(files)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'latest_job_id');
    expect(col).toMatchObject({ notnull: 0 });
  });
});

describe('files.latest_job_id after every migration', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    seedBase(db);
    addFile(db, 'f');
  });
  afterEach(() => closeDatabase(db));

  const job = (id: string, o: { state: JobState; dryRun?: boolean; queuedAt: number }) =>
    insertJob(
      db,
      {
        id,
        runId: 'r1',
        libraryId: 'l1',
        fileId: 'f',
        path: '/media/f.mkv',
        workflowId: 'w1',
        workflowVersion: 1,
        dryRun: o.dryRun ?? false,
        testEncode: false,
        state: o.state,
        priority: 0,
      },
      at(o.queuedAt),
    );

  /** After every write, the stored id is what the old window query gives. */
  const expectLatest = (id: string | null) => {
    expect(latestOf(db, 'f')).toBe(id);
    expect(windowLatest(db).f ?? null).toBe(id);
  };

  it('keeps its triggers (a later rebuild of jobs or files must recreate them)', () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['jobs_latest_delete', 'jobs_latest_insert', 'jobs_latest_update']),
    );
  });

  it('follows each new job, also one inserted with an older queue time', () => {
    expectLatest(null);
    job('a', { state: 'queued', queuedAt: 1 });
    expectLatest('a');
    job('b', { state: 'queued', queuedAt: 2 });
    expectLatest('b');
    job('older', { state: 'queued', queuedAt: 0 });
    expectLatest('b');
  });

  it('a dry run after a real run does not become the latest; a dry run on its own does', () => {
    job('dry1', { state: 'dry_run', dryRun: true, queuedAt: 1 });
    expectLatest('dry1');
    job('real', { state: 'done', queuedAt: 2 });
    expectLatest('real');
    job('dry2', { state: 'dry_run', dryRun: true, queuedAt: 3 });
    expectLatest('real');
    job('skip', { state: 'skipped', queuedAt: 4 });
    job('ap', { state: 'already_processed', queuedAt: 5 });
    expectLatest('real');
  });

  it('a job that stops counting (cancelled) hands back to the previous one, and counts again when changed back', () => {
    job('done', { state: 'done', queuedAt: 1 });
    job('next', { state: 'queued', queuedAt: 2 });
    expectLatest('next');
    updateJob(db, 'next', { state: 'encoding' }, at(3));
    expectLatest('next');
    updateJob(db, 'next', { state: 'cancelled' }, at(4));
    expectLatest('done');
    db.prepare("UPDATE jobs SET state = 'queued', finished_at = NULL WHERE id = 'next'").run();
    expectLatest('next');
  });

  it('a raw change of queue time or dry-run flag re-ranks', () => {
    job('a', { state: 'done', queuedAt: 1 });
    job('b', { state: 'done', queuedAt: 2 });
    expectLatest('b');
    db.prepare('UPDATE jobs SET queued_at = ? WHERE id = ?').run(at(3).toISOString(), 'a');
    expectLatest('a');
    db.prepare("UPDATE jobs SET dry_run = 1, state = 'dry_run' WHERE id = 'a'").run();
    expectLatest('b');
  });

  it('a deleted job hands back to the previous one, and to NULL when it was the last', () => {
    job('a', { state: 'done', queuedAt: 1 });
    job('b', { state: 'failed', queuedAt: 2 });
    expectLatest('b');
    db.prepare("DELETE FROM jobs WHERE id = 'b'").run();
    expectLatest('a');
    db.prepare("DELETE FROM jobs WHERE id = 'a'").run();
    expectLatest(null);
  });

  it('a renamed job (its id changed by raw SQL) stays the latest under its new id', () => {
    job('a', { state: 'done', queuedAt: 1 });
    job('b', { state: 'done', queuedAt: 2 });
    expectLatest('b');
    db.prepare("UPDATE jobs SET id = 'b2' WHERE id = 'b'").run();
    expectLatest('b2');
    db.prepare("UPDATE jobs SET id = 'a2' WHERE id = 'a'").run();
    expectLatest('b2');
  });

  it('a job moved to another file re-ranks both files', () => {
    addFile(db, 'g');
    job('a', { state: 'done', queuedAt: 1 });
    job('b', { state: 'done', queuedAt: 2 });
    updateJob(db, 'b', { fileId: 'g' }, at(3));
    expectLatest('a');
    expect(latestOf(db, 'g')).toBe('b');
  });
});
