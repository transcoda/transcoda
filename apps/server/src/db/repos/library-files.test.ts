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
  countListedFiles,
  escapeLike,
  findFileProbe,
  findLibraryFile,
  LIBRARY_FILES_MAX,
  latestJobPerFileSql,
  listFileJobs,
  listLibraryFiles,
  listSeasons,
  listTitles,
  parseShowKey,
  showExists,
  showKey,
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

  it('an episode row carries the key listTitles gives its show; a movie and a file-name file carry none', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('j1', 'f1', { state: 'done', queuedAt: 1, media: ep(2, 1) });
    file('f2', '/media/movies/Sherlock Jr. (1924).mkv', 1000);
    job('j2', 'f2', { state: 'done', queuedAt: 1, media: movie('Sherlock Jr.', 1924) });
    file('f3', '/media/movies/The General (1926).mkv', 1000);
    job('j3', 'f3', { state: 'done', queuedAt: 1 });
    const card = listTitles(db, { libraryId: 'l1', offset: 0, limit: 10 }).items[0];
    const episode = findLibraryFile(db, 'l1', 'f1');
    expect(episode?.showKey).toBe(card?.type === 'show' ? card.key : null);
    expect(episode?.season).toBe(2);
    for (const id of ['f2', 'f3']) {
      expect(findLibraryFile(db, 'l2', id)).toMatchObject({ showKey: null, season: null });
    }
  });

  it('a latest job without media takes its show key from an older job that has media', () => {
    file('f1', '/media/tv/a.mkv', 1000);
    job('j1', 'f1', { state: 'failed', queuedAt: 1, media: ep(null, 1) });
    job('j2', 'f1', { state: 'done', queuedAt: 2 });
    expect(findLibraryFile(db, 'l1', 'f1')).toMatchObject({
      showKey: showKey({ title: SHOW, year: 1962 }),
      season: 'none',
    });
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

  it('countListedFiles counts exactly what the unfiltered list lists', () => {
    file('a', '/media/tv/a.mkv', 1000);
    job('ja1', 'a', { state: 'failed', queuedAt: 1 });
    job('ja2', 'a', { state: 'done', queuedAt: 2 });
    file('b', '/media/tv/b.mkv', 1000);
    job('jb', 'b', { state: 'skipped', queuedAt: 1 });
    file('gone', '/media/tv/gone.mkv', 1000);
    job('jg', 'gone', { state: 'done', queuedAt: 1 });
    db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(5).toISOString(), 'gone');
    file('nojob', '/media/tv/nojob.mkv', 1000);
    file('m', '/media/movies/m.mkv', 1000);
    job('jm', 'm', { state: 'done', queuedAt: 1 });
    expect(countListedFiles(db, 'l1')).toBe(2);
    expect(countListedFiles(db, 'l1')).toBe(listLibraryFiles(db, q()).total);
    expect(countListedFiles(db, 'l2')).toBe(listLibraryFiles(db, q({ libraryId: 'l2' })).total);
    expect(countListedFiles(db, 'nope')).toBe(0);
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

describe('titles and seasons', () => {
  const HILL = { title: SHOW, year: 1962 };
  const done = { beforeBytes: 1000, afterBytes: 600, replacedTo: 'recycle' as const };
  const withPoster = (m: StoredJobMedia, posterPath: string): StoredJobMedia => ({
    ...m,
    posterPath,
  });
  const tq = (over: Partial<Parameters<typeof listTitles>[1]> = {}) =>
    listTitles(db, { libraryId: 'l1', offset: 0, limit: 100, ...over });
  const label = (i: ReturnType<typeof listTitles>['items'][number]) =>
    i.type === 'show' ? i.title : (i.poster?.media.title ?? '');
  const titles = (over: Partial<Parameters<typeof listTitles>[1]> = {}) =>
    tq(over).items.map(label);
  const showCard = (over: Partial<Parameters<typeof listTitles>[1]> = {}, title = SHOW) => {
    const s = tq(over).items.find((i) => i.type === 'show' && i.title === title);
    if (s?.type !== 'show') throw new Error('no show card');
    return s;
  };
  const addEp = (id: string, season: number | null, episode: number, state: JobState = 'done') => {
    file(id, `/media/tv/${id}.mkv`, 1000);
    job(`j-${id}`, id, { state, queuedAt: 1, media: ep(season, episode) });
  };

  function seedHillbillies(): void {
    file('e1', '/media/tv/e1.mkv', 1000);
    job('j-e1', 'e1', { state: 'done', queuedAt: 1, media: ep(1, 1), result: done });
    file('e2', '/media/tv/e2.mkv', 1000);
    job('j-e2', 'e2', {
      state: 'kept_original',
      queuedAt: 1,
      media: ep(1, 2),
      result: { beforeBytes: 1000, afterBytes: 1200 },
    });
    file('e3', '/media/tv/e3.mkv', 1000);
    job('j-e3', 'e3', { state: 'failed', queuedAt: 1, media: ep(2, 1) });
  }

  it('groups episodes into one show card and lists movies one per file, by title', () => {
    seedHillbillies();
    file('m1', '/media/tv/m1.mkv', 1000);
    job('j-m1', 'm1', {
      state: 'done',
      queuedAt: 1,
      media: movie('Night of the Living Dead', 1968),
    });
    file('m2', '/media/tv/m2.mkv', 1000);
    job('j-m2', 'm2', { state: 'done', queuedAt: 1, media: movie('Sherlock Jr.', 1924) });
    expect(tq().items.map((i) => [i.type, label(i)])).toEqual([
      ['movie', 'Night of the Living Dead'],
      ['movie', 'Sherlock Jr.'],
      ['show', SHOW],
    ]);
    const m = tq().items[0];
    expect(m).toMatchObject({ type: 'movie', fileId: 'm1', latest: { id: 'j-m1' } });
    expect(tq().total).toBe(3);
  });

  it('a show card counts episodes, seasons, outcomes and space saved', () => {
    seedHillbillies();
    expect(showCard()).toMatchObject({
      key: showKey(HILL),
      year: 1962,
      episodes: 3,
      seasons: 2,
      outcomes: { replaced: 1, kept: 1, failed: 1, other: 0 },
      savedBytes: 400,
    });
  });

  it('a restored replace no longer counts as replaced or as space saved; running jobs are other', () => {
    seedHillbillies();
    insertRestore(db, {
      id: 'x1',
      jobId: 'j-e1',
      restoredAt: at(2).toISOString(),
      restoredBy: 'u',
      sidecarPaths: [],
    });
    addEp('e4', 2, 2, 'encoding');
    expect(showCard().episodes).toBe(4);
    // e1 has an active restore, so it is other; e4 is still encoding.
    expect(showCard().outcomes).toEqual({ replaced: 0, kept: 1, failed: 1, other: 2 });
    expect(showCard().savedBytes).toBe(0);
  });

  it('the same title with another year is another show; gone and job-less files are not counted', () => {
    seedHillbillies();
    file('r1', '/media/tv/r1.mkv', 1000);
    job('j-r1', 'r1', { state: 'done', queuedAt: 1, media: { ...ep(1, 1), year: 2026 } });
    file('nojob', '/media/tv/nojob.mkv', 1000);
    file('gone', '/media/tv/gone.mkv', 1000);
    job('j-gone', 'gone', { state: 'done', queuedAt: 1, media: ep(3, 1) });
    db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(5).toISOString(), 'gone');
    const shows = tq().items.flatMap((i) => (i.type === 'show' ? [[i.year, i.episodes]] : []));
    expect(shows).toEqual([
      [1962, 3],
      [2026, 1],
    ]);
    expect(showCard().seasons).toBe(2);
  });

  it('the show poster is the lowest episode that has one', () => {
    addEp('e1', 1, 1);
    file('e2', '/media/tv/e2.mkv', 1000);
    job('j-e2', 'e2', { state: 'done', queuedAt: 1, media: withPoster(ep(1, 2), '/p/2.jpg') });
    file('e3', '/media/tv/e3.mkv', 1000);
    job('j-e3', 'e3', { state: 'done', queuedAt: 1, media: withPoster(ep(2, 1), '/p/3.jpg') });
    expect(showCard().poster).toMatchObject({
      jobId: 'j-e2',
      media: { posterPath: '/p/2.jpg', episode: 2 },
    });
  });

  it('with no poster anywhere the poster is the lowest file; with no media at all it is null', () => {
    addEp('e2', 1, 2);
    addEp('e1', 1, 1);
    expect(showCard().poster).toMatchObject({ jobId: 'j-e1', media: { episode: 1 } });
    file('m', '/media/tv/Superman (1978).mkv', 1000);
    job('j-m', 'm', { state: 'done', queuedAt: 1 });
    const m = tq().items.find((i) => i.type === 'movie');
    expect(m).toMatchObject({ type: 'movie', fileId: 'm', poster: null });
  });

  it('search finds shows and movies by title only', () => {
    seedHillbillies();
    file('m1', '/media/tv/m1.mkv', 1000);
    job('j-m1', 'm1', { state: 'done', queuedAt: 1, media: movie('Sherlock Jr.', 1924) });
    expect(titles({ search: 'hillbil' })).toEqual([SHOW]);
    expect(showCard({ search: 'hillbil' }).episodes).toBe(3);
    expect(titles({ search: 'sherlock' })).toEqual(['Sherlock Jr.']);
    expect(titles({ search: 'S01E01' })).toEqual([]);
    expect(titles({ search: 'e1.mkv' })).toEqual([]);
    expect(titles({ search: '%' })).toEqual([]);
  });

  it('pages the items with a total', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      file(`m${n}`, `/media/tv/m${n}.mkv`, 1000);
      job(`j-m${n}`, `m${n}`, { state: 'done', queuedAt: 1, media: movie(`Movie ${n}`, 1950) });
    }
    const page = tq({ offset: 2, limit: 2 });
    expect(page.total).toBe(5);
    expect(page.items.map(label)).toEqual(['Movie 3', 'Movie 4']);
    expect(tq({ offset: 10, limit: 2 })).toEqual({ items: [], total: 5 });
  });

  it('showKey round-trips, and parseShowKey refuses garbage', () => {
    expect(parseShowKey(showKey(HILL))).toEqual(HILL);
    expect(parseShowKey(showKey({ title: 'Superman', year: null }))).toEqual({
      title: 'Superman',
      year: null,
    });
    expect(parseShowKey('not-a-key')).toBeNull();
    expect(parseShowKey(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
    expect(parseShowKey(Buffer.from('["a","1962"]').toString('base64url'))).toBeNull();
    expect(parseShowKey(Buffer.from('["a",1962,3]').toString('base64url'))).toBeNull();
  });

  it('a show card counts exactly the files listLibraryFiles returns for its show', () => {
    seedHillbillies();
    addEp('e4', null, 1);
    file('r1', '/media/tv/r1.mkv', 1000);
    job('j-r1', 'r1', { state: 'done', queuedAt: 1, media: { ...ep(1, 1), year: null } });
    file('gone', '/media/tv/gone.mkv', 1000);
    job('j-gone', 'gone', { state: 'done', queuedAt: 1, media: ep(3, 1) });
    db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(5).toISOString(), 'gone');
    file('c', '/media/tv/c.mkv', 1000);
    job('j-c', 'c', {
      state: 'done',
      queuedAt: 1,
      media: { ...ep(1, 1), title: SHOW.toLowerCase() },
    });
    const shows = tq().items.filter((i) => i.type === 'show');
    expect(shows.length).toBe(3);
    for (const s of shows) {
      const ref = parseShowKey(s.type === 'show' ? s.key : '');
      if (!ref) throw new Error('bad key');
      expect(listLibraryFiles(db, q({ show: ref })).total).toBe(
        s.type === 'show' ? s.episodes : -1,
      );
    }
  });

  it('listSeasons gives each season its episodes, outcomes and poster; no season comes last as none', () => {
    seedHillbillies();
    file('e4', '/media/tv/e4.mkv', 1000);
    job('j-e4', 'e4', { state: 'done', queuedAt: 1, media: withPoster(ep(null, 1), '/p/n.jpg') });
    const seasons = listSeasons(db, 'l1', HILL);
    expect(seasons.map((s) => [s.season, s.episodes])).toEqual([
      [1, 2],
      [2, 1],
      ['none', 1],
    ]);
    expect(seasons[0]).toMatchObject({
      outcomes: { replaced: 1, kept: 1, failed: 0, other: 0 },
      savedBytes: 400,
      poster: { jobId: 'j-e1' },
    });
    expect(seasons[2]).toMatchObject({
      poster: { jobId: 'j-e4', media: { posterPath: '/p/n.jpg' } },
    });
    expect(listSeasons(db, 'l1', { title: SHOW, year: 1999 })).toEqual([]);
    expect(listSeasons(db, 'l2', HILL)).toEqual([]);
  });

  it('case-variant titles of the same year never tie: pages hold each card once, in a fixed order', () => {
    // Inserted lower case first, so an unordered tie would tend to put it first.
    file('lo', '/media/tv/lo.mkv', 1000);
    job('j-lo', 'lo', { state: 'done', queuedAt: 1, media: { ...ep(1, 1), title: 'superman' } });
    file('up', '/media/tv/up.mkv', 1000);
    job('j-up', 'up', { state: 'done', queuedAt: 1, media: { ...ep(1, 1), title: 'Superman' } });
    file('caps', '/media/tv/caps.mkv', 1000);
    job('j-caps', 'caps', {
      state: 'done',
      queuedAt: 1,
      media: { ...ep(1, 1), title: 'SUPERMAN' },
    });
    expect(titles()).toEqual(['SUPERMAN', 'Superman', 'superman']);
    const paged = [0, 1, 2].map((offset) => titles({ offset, limit: 1 })[0]);
    expect(paged).toEqual(['SUPERMAN', 'Superman', 'superman']);
  });

  it('showExists finds a show with a present episode only', () => {
    seedHillbillies();
    expect(showExists(db, 'l1', HILL)).toBe(true);
    expect(showExists(db, 'l1', { title: SHOW, year: 1999 })).toBe(false);
    expect(showExists(db, 'l1', { title: SHOW.toUpperCase(), year: 1962 })).toBe(false);
    expect(showExists(db, 'l2', HILL)).toBe(false);
    db.prepare("UPDATE files SET gone_at = ? WHERE id IN ('e1','e2','e3')").run(
      at(5).toISOString(),
    );
    expect(showExists(db, 'l1', HILL)).toBe(false);
  });
});

describe('findFileProbe', () => {
  it('reads the stored probe; a corrupt one reads as none', () => {
    file('p1', '/media/tv/p1.mkv', 1000);
    db.prepare('UPDATE files SET last_probe = ? WHERE id = ?').run('{"sizeBytes":1000}', 'p1');
    expect(findFileProbe(db, 'p1')).toEqual({ sizeBytes: 1000 });
    db.prepare('UPDATE files SET last_probe = ? WHERE id = ?').run('{"sizeBytes":', 'p1');
    expect(findFileProbe(db, 'p1')).toBeNull();
    expect(findFileProbe(db, 'unknown')).toBeNull();
  });
});
