import { emptyGraph, type JobState, parseFileName, type StoredJobMedia } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import {
  insertJob,
  insertJobResult,
  type JobResultRow,
  listJobListRows,
  upsertFile,
} from './jobs.ts';
import { insertLibrary } from './libraries.ts';
import {
  escapeLike,
  findLibraryFile,
  LIBRARY_FILES_MAX,
  latestJobPerFileSql,
  listFileJobs,
  listLibraryFiles,
} from './library-files.ts';
import { insertRestore } from './restores.ts';
import { insertRun } from './runs.ts';
import { insertWorkflow } from './workflows.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);

const SHOW = 'The Beverly Hillbillies';
const ep = (
  season: number | null,
  episode: number,
  episodeTitle: string | null = null,
): StoredJobMedia => ({
  kind: 'episode',
  title: SHOW,
  year: 1962,
  season,
  episode,
  episodeTitle,
  source: 'sidecar',
  posterPath: null,
});
const movie = (title: string, year: number): StoredJobMedia => ({
  kind: 'movie',
  title,
  year,
  season: null,
  episode: null,
  episodeTitle: null,
  source: 'sidecar',
  posterPath: null,
});

let db: Database;

/** l1 holds /media/tv, l2 /media/movies. */
const libraryOf = (path: string) => (path.startsWith('/media/movies/') ? 'l2' : 'l1');

function file(id: string, path: string, size: number, mtimeMs = 1): void {
  const row = upsertFile(
    db,
    {
      libraryId: libraryOf(path),
      path,
      fingerprint: { sizeBytes: size, mtimeMs, ino: 1, dev: 1, nlink: 1 },
      lastProbe: null,
    },
    now,
  );
  db.prepare('UPDATE files SET id = ? WHERE id = ?').run(id, row.id);
}

function job(
  id: string,
  fileId: string,
  o: {
    state: JobState;
    dryRun?: boolean;
    queuedAt: number;
    media?: StoredJobMedia | null;
    result?: Partial<JobResultRow>;
  },
): void {
  const f = db.prepare('SELECT path, library_id FROM files WHERE id = ?').get(fileId) as {
    path: string;
    library_id: string;
  };
  insertJob(
    db,
    {
      id,
      runId: f.library_id === 'l2' ? 'r2' : 'r1',
      libraryId: f.library_id,
      fileId,
      path: f.path,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: o.dryRun ?? false,
      testEncode: false,
      state: o.state,
      priority: 0,
      media: o.media ?? null,
    },
    at(o.queuedAt),
  );
  if (o.result) {
    insertJobResult(db, {
      jobId: id,
      fingerprint: 'k1',
      workflowId: 'w1',
      workflowVersion: 1,
      outcome: o.state,
      beforeBytes: null,
      afterBytes: null,
      estimatedBytes: null,
      command: null,
      plan: null,
      replacedTo: null,
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      sourceDamaged: false,
      createdAt: at(o.queuedAt).toISOString(),
      ...o.result,
    });
  }
}

type Query = Parameters<typeof listLibraryFiles>[1];
const q = (over: Partial<Query> = {}): Query => ({
  libraryId: 'l1',
  sort: 'title',
  desc: false,
  offset: 0,
  limit: 100,
  ...over,
});
const rows = (over: Partial<Query> = {}) => listLibraryFiles(db, q(over)).rows;
const paths = (over: Partial<Query> = {}) => rows(over).map((r) => r.path);
const only = (over: Partial<Query> = {}) => {
  const r = rows(over);
  expect(r).toHaveLength(1);
  return r[0] as (typeof r)[number];
};

beforeEach(() => {
  db = createTestDb();
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  for (const [id, name, path] of [
    ['l1', 'TV', '/media/tv'],
    ['l2', 'Movies', '/media/movies'],
  ] as const) {
    insertLibrary(db, { id, name, path, recycleFolder: null, processHardlinked: false }, now);
    insertRun(
      db,
      {
        id: id === 'l1' ? 'r1' : 'r2',
        libraryId: id,
        workflowId: 'w1',
        workflowVersion: 1,
        requestedPath: path,
        dryRun: false,
        testEncode: false,
        force: false,
        createdBy: 'u',
      },
      now,
    );
  }
});

describe('latest job of a file', () => {
  it('skips a newer dry run, skipped, already_processed and cancelled job for the newest real one', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('done-t1', 'f1', { state: 'done', queuedAt: 1 });
    job('ap-t2', 'f1', { state: 'already_processed', queuedAt: 2 });
    job('dry-t3', 'f1', { state: 'dry_run', dryRun: true, queuedAt: 3 });
    job('can-t4', 'f1', { state: 'cancelled', queuedAt: 4 });
    job('skip-t5', 'f1', { state: 'skipped', queuedAt: 5 });
    expect(only().latest?.id).toBe('done-t1');
  });

  it('falls back to the newest job of any kind when no job counts', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('dry-t1', 'f1', { state: 'dry_run', dryRun: true, queuedAt: 1 });
    job('ap-t2', 'f1', { state: 'already_processed', queuedAt: 2 });
    expect(only().latest?.id).toBe('ap-t2');
  });

  it('an active job counts and is the latest', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('done-t1', 'f1', { state: 'done', queuedAt: 1 });
    job('enc-t2', 'f1', { state: 'encoding', queuedAt: 2 });
    expect(only().latest).toMatchObject({ id: 'enc-t2', state: 'encoding' });
  });

  it('a job queued at the same time as another: the later inserted one is the latest', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('first', 'f1', { state: 'failed', queuedAt: 1 });
    job('second', 'f1', { state: 'done', queuedAt: 1 });
    expect(only().latest?.id).toBe('second');
  });

  it('takes the media from the latest job, else from the newest job that has some', () => {
    file('fa', '/media/tv/a.mkv', 1000);
    job('a-done', 'fa', { state: 'done', queuedAt: 1, media: ep(1, 1, 'A') });
    job('a-ap', 'fa', { state: 'already_processed', queuedAt: 2, media: ep(1, 1, 'B') });
    file('fb', '/media/tv/b.mkv', 1000);
    job('b-dry', 'fb', { state: 'dry_run', dryRun: true, queuedAt: 1, media: ep(1, 2, 'C') });
    job('b-done', 'fb', { state: 'done', queuedAt: 2 });
    const byPath = Object.fromEntries(rows().map((r) => [r.path, r]));
    expect(byPath['/media/tv/a.mkv']).toMatchObject({
      mediaJobId: 'a-done',
      media: { episodeTitle: 'A' },
      latest: { id: 'a-done' },
    });
    expect(byPath['/media/tv/b.mkv']).toMatchObject({
      mediaJobId: 'b-dry',
      media: { episodeTitle: 'C' },
      latest: { id: 'b-done' },
    });
  });

  it('a file with no media on any job gets its file-name media', () => {
    file('f1', '/media/movies/Sherlock Jr. (1924).mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1 });
    const row = only({ libraryId: 'l2' });
    expect(row.media).toEqual(
      parseFileName('/media/movies/Sherlock Jr. (1924).mkv', '/media/movies'),
    );
    expect(row.media).toMatchObject({ kind: 'movie', source: 'filename', year: 1924 });
    expect(row.mediaJobId).toBeNull();
  });

  it('a file with no job is not listed', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    file('f2', '/media/tv/b.mkv', 1000);
    job('j2', 'f2', { state: 'done', queuedAt: 1 });
    expect(paths()).toEqual(['/media/tv/b.mkv']);
    expect(findLibraryFile(db, 'l1', 'f1')).toBeNull();
  });
});

describe('now values', () => {
  const replaced = { beforeBytes: 1000, afterBytes: 600, replacedTo: 'recycle' as const };

  it('a replaced file shows afterBytes as its size and the original as originalBytes', () => {
    file('f1', '/media/tv/a.mkv', 1000, 5);
    job('j1', 'f1', { state: 'done', queuedAt: 1, result: replaced });
    expect(only()).toMatchObject({
      sizeBytes: 600,
      originalBytes: 1000,
      mtime: new Date(5).toISOString(),
      fileName: 'a.mkv',
      goneAt: null,
    });
  });

  it('a restored replace shows the original size', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1, result: replaced });
    insertRestore(db, {
      id: 'x1',
      jobId: 'j1',
      restoredAt: at(2).toISOString(),
      restoredBy: 'u',
      sidecarPaths: [],
    });
    expect(only()).toMatchObject({ sizeBytes: 1000, originalBytes: null });
  });

  it('a file the latest job did not replace shows its own size', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('j1', 'f1', {
      state: 'kept_original',
      queuedAt: 1,
      result: { beforeBytes: 1000, afterBytes: 1200 },
    });
    expect(only()).toMatchObject({ sizeBytes: 1000, originalBytes: null });
  });

  it('a replaced file keeps its row and path', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1, result: replaced });
    // A later Scan now finds the replaced file (new fingerprint) on the same path.
    upsertFile(
      db,
      {
        libraryId: 'l1',
        path: '/media/tv/a.mkv',
        fingerprint: { sizeBytes: 600, mtimeMs: 9, ino: 7, dev: 1, nlink: 1 },
        lastProbe: null,
      },
      at(3),
    );
    job('j2', 'f1', { state: 'already_processed', queuedAt: 3 });
    expect(listLibraryFiles(db, q()).rows.map((r) => [r.path, r.latest?.state])).toEqual([
      ['/media/tv/a.mkv', 'done'],
    ]);
    expect(only()).toMatchObject({ id: 'f1', sizeBytes: 600, originalBytes: 1000 });
  });
});

describe('listLibraryFiles', () => {
  it('hides gone files; findLibraryFile still finds them', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    file('f2', '/media/tv/b.mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1 });
    job('j2', 'f2', { state: 'done', queuedAt: 1 });
    db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(5).toISOString(), 'f2');
    expect(listLibraryFiles(db, q())).toMatchObject({ rows: [{ id: 'f1' }], total: 1 });
    expect(findLibraryFile(db, 'l1', 'f2')).toMatchObject({
      id: 'f2',
      goneAt: at(5).toISOString(),
      latest: { id: 'j2' },
    });
  });

  it('pages with offset and limit and reports the total', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      file(`f${n}`, `/media/tv/S01E0${n}.mkv`, 1000);
      job(`j${n}`, `f${n}`, { state: 'done', queuedAt: 1, media: ep(1, n) });
    }
    const page = listLibraryFiles(db, q({ offset: 2, limit: 2 }));
    expect(page.total).toBe(5);
    expect(page.rows.map((r) => r.id)).toEqual(['f3', 'f4']);
    expect(listLibraryFiles(db, q({ offset: 10, limit: 2 }))).toEqual({ rows: [], total: 5 });
  });

  it('caps the page at LIBRARY_FILES_MAX', () => {
    for (let n = 0; n < LIBRARY_FILES_MAX + 5; n++) {
      file(`f${n}`, `/media/tv/${n}.mkv`, 1000);
      job(`j${n}`, `f${n}`, { state: 'done', queuedAt: 1 });
    }
    const page = listLibraryFiles(db, q({ limit: 1000 }));
    expect(page.rows).toHaveLength(LIBRARY_FILES_MAX);
    expect(page.total).toBe(LIBRARY_FILES_MAX + 5);
  });

  it('sorts by title, then season and episode; desc flips it', () => {
    file('m1', '/media/tv/notld.mkv', 1000);
    job('jm1', 'm1', {
      state: 'done',
      queuedAt: 1,
      media: movie('night of the Living Dead', 1968),
    });
    file('e22', '/media/tv/S02E02.mkv', 1000);
    job('je22', 'e22', { state: 'done', queuedAt: 1, media: ep(2, 2) });
    file('e21', '/media/tv/S02E01.mkv', 1000);
    job('je21', 'e21', { state: 'done', queuedAt: 1, media: ep(2, 1) });
    file('e11', '/media/tv/S01E01.mkv', 1000);
    job('je11', 'e11', { state: 'done', queuedAt: 1, media: ep(1, 1) });
    file('m2', '/media/tv/Sherlock.mkv', 1000);
    job('jm2', 'm2', { state: 'done', queuedAt: 1, media: movie('Sherlock Jr.', 1924) });
    const ids = (desc: boolean) => rows({ desc }).map((r) => r.id);
    // NOCASE: "night…" sorts before "Sherlock…".
    expect(ids(false)).toEqual(['m1', 'm2', 'e11', 'e21', 'e22']);
    // desc flips the title only; a show's episodes stay in order.
    expect(ids(true)).toEqual(['e11', 'e21', 'e22', 'm2', 'm1']);
  });

  it('a file with no media sorts by its file name', () => {
    file('f1', '/media/tv/Superman.mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1 });
    file('f2', '/media/tv/x.mkv', 1000);
    job('j2', 'f2', { state: 'done', queuedAt: 1, media: movie('The General', 1926) });
    expect(paths()).toEqual(['/media/tv/Superman.mkv', '/media/tv/x.mkv']);
  });

  it('sorts by size using the now size', () => {
    file('a', '/media/tv/a.mkv', 1000);
    job('ja', 'a', {
      state: 'done',
      queuedAt: 1,
      result: { beforeBytes: 1000, afterBytes: 600, replacedTo: 'recycle' },
    });
    file('b', '/media/tv/b.mkv', 800);
    job('jb', 'b', { state: 'done', queuedAt: 1 });
    file('c', '/media/tv/c.mkv', 700);
    job('jc', 'c', { state: 'done', queuedAt: 1 });
    expect(rows({ sort: 'size' }).map((r) => [r.id, r.sizeBytes])).toEqual([
      ['a', 600],
      ['c', 700],
      ['b', 800],
    ]);
    expect(rows({ sort: 'size', desc: true }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by last run and by result', () => {
    file('a', '/media/tv/a.mkv', 1000);
    job('ja', 'a', { state: 'failed', queuedAt: 3 });
    file('b', '/media/tv/b.mkv', 1000);
    job('jb', 'b', { state: 'queued', queuedAt: 1 });
    file('c', '/media/tv/c.mkv', 1000);
    job('jc', 'c', { state: 'done', queuedAt: 2 });
    expect(rows({ sort: 'lastRun' }).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(rows({ sort: 'lastRun', desc: true }).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    // States sort by name: done, failed, queued.
    expect(rows({ sort: 'result' }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(rows({ sort: 'result', desc: true }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('searches title, episode title and file name, case-insensitively', () => {
    file('e1', '/media/tv/Hillbillies/S01E01.mkv', 1000);
    job('j1', 'e1', { state: 'done', queuedAt: 1, media: ep(1, 1, 'The Clampetts Strike Oil') });
    file('e2', '/media/tv/Hillbillies/S01E02.mkv', 1000);
    job('j2', 'e2', {
      state: 'done',
      queuedAt: 1,
      media: ep(1, 2, 'Getting Settled; Jed Buys Stocks'),
    });
    file('m1', '/media/tv/General.mkv', 1000);
    job('j3', 'm1', { state: 'done', queuedAt: 1, media: movie('The General', 1926) });
    expect(paths({ search: 'beverly' })).toHaveLength(2);
    expect(paths({ search: 'JED BUYS' })).toEqual(['/media/tv/Hillbillies/S01E02.mkv']);
    expect(paths({ search: 'S01E02.mkv' })).toHaveLength(1);
    expect(listLibraryFiles(db, q({ search: 'general' })).total).toBe(1);
  });

  it('a % or _ in the search is literal', () => {
    file('a', '/media/movies/100% Superman.mkv', 1000);
    job('ja', 'a', { state: 'done', queuedAt: 1 });
    file('b', '/media/movies/100x Superman.mkv', 1000);
    job('jb', 'b', { state: 'done', queuedAt: 1 });
    expect(paths({ libraryId: 'l2', search: '100%' })).toEqual(['/media/movies/100% Superman.mkv']);
    expect(paths({ libraryId: 'l2', search: '_' })).toEqual([]);
    expect(paths({ libraryId: 'l2', search: '100' })).toHaveLength(2);
  });

  it('filters by show and season, and season none', () => {
    file('e11', '/media/tv/S01E01.mkv', 1000);
    job('j11', 'e11', { state: 'done', queuedAt: 1, media: ep(1, 1) });
    file('e21', '/media/tv/S02E01.mkv', 1000);
    job('j21', 'e21', { state: 'done', queuedAt: 1, media: ep(2, 1) });
    file('en', '/media/tv/special.mkv', 1000);
    job('jn', 'en', { state: 'done', queuedAt: 1, media: ep(null, 7) });
    file('other', '/media/tv/other.mkv', 1000);
    job('jo', 'other', { state: 'done', queuedAt: 1, media: { ...ep(1, 1), year: 1990 } });
    file('mv', '/media/tv/movie.mkv', 1000);
    job('jm', 'mv', { state: 'done', queuedAt: 1, media: movie(SHOW, 1962) });
    const show = { title: SHOW, year: 1962 };
    expect(rows({ show }).map((r) => r.id)).toEqual(['en', 'e11', 'e21']);
    expect(rows({ show, season: 2 }).map((r) => r.id)).toEqual(['e21']);
    expect(rows({ show, season: 'none' }).map((r) => r.id)).toEqual(['en']);
    expect(rows({ show: { title: SHOW, year: 1990 } }).map((r) => r.id)).toEqual(['other']);
    expect(rows({ show: { title: SHOW, year: null } })).toEqual([]);
  });

  it('never lists another library’s files', () => {
    file('t', '/media/tv/a.mkv', 1000);
    job('jt', 't', { state: 'done', queuedAt: 1 });
    file('m', '/media/movies/b.mkv', 1000);
    job('jm', 'm', { state: 'done', queuedAt: 1 });
    expect(listLibraryFiles(db, q())).toMatchObject({ rows: [{ id: 't' }], total: 1 });
    expect(listLibraryFiles(db, q({ libraryId: 'l2' }))).toMatchObject({
      rows: [{ id: 'm' }],
      total: 1,
    });
    expect(findLibraryFile(db, 'l1', 'm')).toBeNull();
    expect(findLibraryFile(db, 'l1', 'nope')).toBeNull();
    expect(findLibraryFile(db, 'l2', 'm')).toMatchObject({ id: 'm', libraryId: 'l2' });
  });
});

it('escapeLike escapes the backslash, % and _', () => {
  expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
});

it('listJobListRows returns rows in the order of the ids and leaves unknown ids out', () => {
  file('f1', '/media/tv/a.mkv', 1000);
  job('j1', 'f1', { state: 'done', queuedAt: 1 });
  job('j2', 'f1', { state: 'failed', queuedAt: 2 });
  expect(listJobListRows(db, ['j2', 'nope', 'j1']).map((r) => r.id)).toEqual(['j2', 'j1']);
  expect(listJobListRows(db, [])).toEqual([]);
});

it('listFileJobs lists every job newest first with a total', () => {
  file('f1', '/media/tv/a.mkv', 1000);
  file('f2', '/media/tv/b.mkv', 1000);
  job('j1', 'f1', { state: 'done', queuedAt: 1 });
  job('j2', 'f1', { state: 'dry_run', dryRun: true, queuedAt: 2 });
  job('j3', 'f1', { state: 'already_processed', queuedAt: 3 });
  job('j3b', 'f1', { state: 'skipped', queuedAt: 3 });
  job('other', 'f2', { state: 'done', queuedAt: 4 });
  expect(listFileJobs(db, 'f1', { offset: 0, limit: 10 }).jobs.map((j) => j.id)).toEqual([
    'j3b',
    'j3',
    'j2',
    'j1',
  ]);
  const page = listFileJobs(db, 'f1', { offset: 1, limit: 2 });
  expect(page).toMatchObject({ total: 4 });
  expect(page.jobs.map((j) => j.id)).toEqual(['j3', 'j2']);
  expect(listFileJobs(db, 'nope', { offset: 0, limit: 10 })).toEqual({ jobs: [], total: 0 });
});

describe('latestJobPerFileSql', () => {
  it('without a library covers every library and keeps the latest job’s own media apart', () => {
    file('t', '/media/tv/a.mkv', 1000);
    job('t-dry', 't', { state: 'dry_run', dryRun: true, queuedAt: 1, media: ep(1, 1) });
    job('t-done', 't', { state: 'done', queuedAt: 2 });
    file('m', '/media/movies/b.mkv', 1000);
    job('m-done', 'm', { state: 'done', queuedAt: 1, media: movie('The General', 1926) });
    const { sql, params } = latestJobPerFileSql({});
    const got = db
      .prepare(
        `${sql} SELECT file_id, latest_id, latest_media IS NULL AS own_null, media_id FROM latest ORDER BY file_id`,
      )
      .all(params);
    expect(got).toEqual([
      { file_id: 'm', latest_id: 'm-done', own_null: 0, media_id: 'm-done' },
      { file_id: 't', latest_id: 't-done', own_null: 1, media_id: 't-dry' },
    ]);
    const one = latestJobPerFileSql({ libraryId: 'l2' });
    expect(db.prepare(`${one.sql} SELECT file_id FROM latest`).all(one.params)).toEqual([
      { file_id: 'm' },
    ]);
  });
});

// Measured once: about 560 ms for the title page and the search together (no wall-clock bound).
it('stays fast at 20,000 files', () => {
  const N = 20_000;
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const isEpisode = i % 2 === 0;
      const path = isEpisode
        ? `/media/tv/Hillbillies/S${String(i % 9).padStart(2, '0')}E${String(i).padStart(5, '0')}.mkv`
        : `/media/tv/Movies/Superman ${String(i).padStart(5, '0')}.mkv`;
      file(`f${i}`, path, 1000 + i);
      const media = isEpisode
        ? ep(i % 9, i)
        : movie(`Superman ${String(i).padStart(5, '0')}`, 1941);
      job(`d${i}`, `f${i}`, { state: 'done', queuedAt: 1, media });
      job(`a${i}`, `f${i}`, { state: 'already_processed', queuedAt: 2, media });
    }
  })();

  const seen: { sql: string; args: unknown[] }[] = [];
  const realPrepare = db.prepare.bind(db);
  const prepare = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const st = realPrepare(sql);
    const all = st.all.bind(st);
    st.all = (...args: unknown[]) => {
      seen.push({ sql, args });
      return all(...(args as []));
    };
    return st;
  });
  const page = listLibraryFiles(db, { ...q(), limit: 100 });
  const found = listLibraryFiles(db, { ...q(), search: 'beverly', limit: 100 });

  expect(page.total).toBe(N);
  expect(page.rows).toHaveLength(100);
  // Movies "Superman 00001"… sort before "The Beverly Hillbillies".
  expect(page.rows[0]).toMatchObject({ id: 'f1', latest: { id: 'd1', state: 'done' } });
  expect(page.rows[99]).toMatchObject({ id: 'f199' });
  expect(found.total).toBe(N / 2);
  expect(found.rows[0]).toMatchObject({ media: { title: SHOW, season: 0 } });

  // The per-file latest-job lookup reads jobs through jobs_file_queued.
  const listing = seen.find((c) => c.sql.includes('ROW_NUMBER()'));
  prepare.mockRestore();
  if (!listing) throw new Error('the listing query was not run');
  const plan = (
    db.prepare(`EXPLAIN QUERY PLAN ${listing.sql}`).all(...(listing.args as [])) as {
      detail: string;
    }[]
  ).map((r) => r.detail);
  expect(plan.some((d) => /\bj\b.*jobs_file_queued/.test(d))).toBe(true);
}, 60_000);
