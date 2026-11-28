import { defineNode } from '@transcoda/sdk';
import {
  emptyGraph,
  type JobState,
  type NodeInstance,
  type StoredJobMedia,
} from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp, type TestApp } from '../../app/testing/app.ts';
import {
  asSession,
  bearer,
  createToken,
  login,
  type Session,
  send,
} from '../../app/testing/http.ts';
import { upsertFile } from '../../db/repos/files.ts';
import {
  insertJob,
  insertJobResult,
  type JobResultRow,
  setJobProbe,
} from '../../db/repos/jobs/jobs.ts';
import { insertLibrary, softDeleteLibrary } from '../../db/repos/libraries.ts';
import { showKey } from '../../db/repos/library-files.ts';
import { insertRestore } from '../../db/repos/restores.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { insertWorkflow, setActiveVersion } from '../../db/repos/workflows.ts';
import { filePort } from '../../nodes/core/common.ts';
import { mainGraph, node, testRegistry } from '../../workflows/testing.ts';

const now = new Date('2026-10-26T00:04:00.000Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const SHOW = 'The Bramblewood Family';

let t: TestApp;
let s: Session;

const media = (over: Partial<StoredJobMedia>): StoredJobMedia => ({
  kind: 'episode',
  title: SHOW,
  year: 1962,
  season: 1,
  episode: 1,
  episodeTitle: null,
  source: 'sidecar',
  posterPath: null,
  ...over,
});

/** A stored probe in the shape the engine keeps (whole ProbeResult, with `raw`). */
const probeOf = (sizeBytes: number, codec: string) => ({
  container: 'matroska',
  formatName: 'matroska,webm',
  durationSeconds: 60,
  sizeBytes,
  bitrateKbps: 100,
  chapters: 0,
  raw: { streams: [] },
  streams: [
    {
      index: 0,
      type: 'video',
      codec,
      language: null,
      title: null,
      default: true,
      forced: false,
      attachedPic: false,
      dispositions: [],
      width: 640,
      height: 480,
      profile: null,
      level: null,
      pixelFormat: null,
      bitDepth: null,
      hdr: null,
      channels: null,
      sampleRate: null,
      bitrateKbps: null,
      frameRate: 24,
    },
  ],
});

function file(id: string, path: string, size: number, libraryId = 'l1'): void {
  const row = upsertFile(
    t.db,
    {
      libraryId,
      path,
      fingerprint: { sizeBytes: size, mtimeMs: 1, ino: 1, dev: 1, nlink: 1 },
      lastProbe: probeOf(size, 'h264') as never,
    },
    now,
  );
  t.db.prepare('UPDATE files SET id = ? WHERE id = ?').run(id, row.id);
}

function job(
  id: string,
  fileId: string,
  o: {
    state: JobState;
    queuedAt: number;
    media?: StoredJobMedia;
    result?: Partial<JobResultRow>;
    probe?: unknown;
  },
): void {
  const f = t.db
    .prepare('SELECT path, library_id, fingerprint FROM files WHERE id = ?')
    .get(fileId) as {
    path: string;
    library_id: string;
    fingerprint: string;
  };
  insertJob(
    t.db,
    {
      id,
      runId: 'r1',
      libraryId: f.library_id,
      fileId,
      path: f.path,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: o.state,
      priority: 0,
      media: o.media ?? null,
    },
    at(o.queuedAt),
  );
  if (o.probe) setJobProbe(t.db, id, o.probe as never);
  if (o.result) {
    insertJobResult(t.db, {
      jobId: id,
      // As a real job records it: the input it probed, which it also stored on the file.
      fingerprint: f.fingerprint,
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

const replaced = {
  beforeBytes: 1000,
  afterBytes: 600,
  replacedTo: 'recycle' as const,
  // As the pipeline stores it: a JobProbe, no `raw`.
  outputProbe: (({ raw: _raw, formatName: _f, chapters: _c, ...p }) => ({
    ...p,
    streams: p.streams.map((x) => ({ ...x, tagBitrateKbps: null })),
  }))(probeOf(600, 'hevc')) as never,
};

beforeEach(async () => {
  t = createTestApp({ start: now });
  s = await login(t);
  insertWorkflow(
    t.db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  for (const [id, path] of [
    ['l1', '/media/tv'],
    ['l2', '/media/other'],
  ] as const) {
    insertLibrary(t.db, { id, name: id, path, recycleFolder: null, processHardlinked: false }, now);
  }
  insertRun(
    t.db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/media/tv',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
  // f1: replaced (after a failed first try), f2: kept, f3: a movie, f9: another library's file.
  file('f1', '/media/tv/S01E01.mkv', 1000);
  job('j1a', 'f1', { state: 'failed', queuedAt: 1, media: media({}) });
  job('j1b', 'f1', {
    state: 'done',
    queuedAt: 2,
    media: media({ posterPath: '/media/tv/poster.jpg' }),
    result: replaced,
    probe: probeOf(1000, 'h264'),
  });
  file('f2', '/media/tv/S01E02.mkv', 800);
  job('j2', 'f2', {
    state: 'kept_original',
    queuedAt: 3,
    media: media({ episode: 2 }),
    result: { beforeBytes: 800, afterBytes: 900 },
  });
  file('f3', '/media/tv/Nocturne of the Quiet Moon.mkv', 500);
  job('j3', 'f3', {
    state: 'done',
    queuedAt: 4,
    media: media({
      kind: 'movie',
      title: 'Nocturne of the Quiet Moon',
      year: 1968,
      season: null,
      episode: null,
    }),
  });
  file('f9', '/media/other/Shepherd Jr.mkv', 300, 'l2');
  job('j9', 'f9', { state: 'done', queuedAt: 5 });
});
afterEach(async () => {
  await t.close();
});

// biome-ignore lint/suspicious/noExplicitAny: a loosely typed JSON body keeps the assertions short
type Body = any;

async function get(path: string, headers: Record<string, string> = asSession(s, false)) {
  const res = await send(t, 'GET', path, { headers });
  return { status: res.status, body: (await res.json()) as Body };
}

describe('library browser read routes', () => {
  it('GET /libraries/:id carries the listed file count', async () => {
    file('nojob', '/media/tv/nojob.mkv', 100);
    const { status, body } = await get('/libraries/l1');
    expect(status).toBe(200);
    expect(body.fileCount).toBe(3);
    expect(body.fileCount).toBe((await get('/libraries/l1/files')).body.total);
    expect((await get('/libraries/l2')).body.fileCount).toBe(1);
  });

  it('GET /libraries/:id/titles returns shows and movies, posters without posterPath', async () => {
    const { status, body } = await get('/libraries/l1/titles');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items.map((i: { type: string }) => i.type)).toEqual(['movie', 'show']);
    const [movie, show] = body.items;
    expect(movie).toMatchObject({
      fileId: 'f3',
      poster: { id: 'j3', media: { poster: false } },
      latest: { id: 'j3' },
    });
    expect(show).toMatchObject({
      key: showKey({ title: SHOW, year: 1962 }),
      episodes: 2,
      outcomes: { replaced: 1, kept: 1, failed: 0, other: 0 },
      savedBytes: 400,
      poster: { id: 'j1b', media: { title: SHOW, poster: true } },
    });
    expect(JSON.stringify(body)).not.toContain('posterPath');
  });

  it('GET /libraries/:id/seasons lists a show’s seasons with poster refs', async () => {
    const key = showKey({ title: SHOW, year: 1962 });
    const { status, body } = await get(`/libraries/l1/seasons?show=${key}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      title: SHOW,
      year: 1962,
      seasons: [{ season: 1, episodes: 2, poster: { id: 'j1b' }, savedBytes: 400 }],
    });
    expect(JSON.stringify(body)).not.toContain('posterPath');
  });

  it("a show card points at the show's own poster (of: show); seasons and files keep theirs, no path leaks", async () => {
    t.db
      .prepare('UPDATE jobs SET media = ? WHERE id = ?')
      .run(JSON.stringify(media({ episode: 2, showPosterPath: '/media/tv/show.jpg' })), 'j2');
    const key = showKey({ title: SHOW, year: 1962 });
    const titles = await get('/libraries/l1/titles');
    const show = titles.body.items.find((i: { type: string }) => i.type === 'show');
    expect(show.poster).toEqual({
      id: 'j2',
      of: 'show',
      media: expect.objectContaining({ episode: 2, poster: true }),
    });
    const seasons = await get(`/libraries/l1/seasons?show=${key}`);
    expect(seasons.body.seasons[0].poster).toEqual({
      id: 'j1b',
      media: expect.objectContaining({ poster: true }),
    });
    const files = await get(`/libraries/l1/files?show=${key}`);
    const f2 = files.body.files.find((f: { id: string }) => f.id === 'f2');
    expect(f2.poster).toEqual({ id: 'j2', media: expect.objectContaining({ poster: false }) });
    const jobs = await get('/jobs');
    expect(jobs.body.jobs.map((j: { id: string }) => j.id)).toContain('j2');
    for (const body of [titles.body, seasons.body, files.body, jobs.body]) {
      expect(JSON.stringify(body)).not.toMatch(/posterPath|show\.jpg/i);
    }
  });

  it('GET /libraries/:id/files pages, sorts and searches over REST query parameters', async () => {
    const { body } = await get('/libraries/l1/files?search=bramble&sort=title&limit=1&offset=1');
    expect(body).toMatchObject({ total: 2, files: [{ fileName: 'S01E02.mkv', id: 'f2' }] });
    expect(body.files).toHaveLength(1);
    const desc = await get('/libraries/l1/files?sort=size&desc=true');
    // Sizes now: f2 800, f1 600 (replaced), f3 500.
    expect(desc.body.files.map((f: { id: string }) => f.id)).toEqual(['f2', 'f1', 'f3']);
    expect(desc.body.files[1]).toMatchObject({
      sizeBytes: 600,
      originalBytes: 1000,
      gone: false,
      latest: { id: 'j1b', state: 'done', heldByRunHours: null },
    });
  });

  it('GET /libraries/:id/files filters by show and season; a season without a show is a 400', async () => {
    const key = showKey({ title: SHOW, year: 1962 });
    const shown = await get(`/libraries/l1/files?show=${key}&season=1`);
    expect(shown.body.files.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2']);
    const none = await get(`/libraries/l1/files?show=${key}&season=none`);
    expect(none.body).toEqual({ files: [], total: 0 });
    const bad = await get('/libraries/l1/files?season=1');
    expect(bad.status).toBe(400);
    expect((await get('/libraries/l1/files?limit=201')).status).toBe(400);
    const noMatch = await get(`/libraries/l1/files?show=${key}&search=zzz`);
    expect([noMatch.status, noMatch.body]).toEqual([200, { files: [], total: 0 }]);
  });

  it('GET /libraries/:id/files/:fileId: a replaced file shows the output probe as now and its own probe as before, jobs newest first', async () => {
    const { status, body } = await get('/libraries/l1/files/f1');
    expect(status).toBe(200);
    expect(body.file).toMatchObject({ id: 'f1', sizeBytes: 600, originalBytes: 1000 });
    expect(body.now).toMatchObject({ sizeBytes: 600, streams: [{ codec: 'hevc' }] });
    expect(body.before).toMatchObject({ sizeBytes: 1000, streams: [{ codec: 'h264' }] });
    expect(body.before).not.toHaveProperty('raw');
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['j1b', 'j1a']);
    expect(body.jobsTotal).toBe(2);
    const page = await get('/libraries/l1/files/f1?jobsLimit=1&jobsOffset=1');
    expect(page.body.jobs.map((j: { id: string }) => j.id)).toEqual(['j1a']);
    expect(page.body.jobsTotal).toBe(2);
    expect((await get('/libraries/l1/files/f1?jobsLimit=201')).status).toBe(400);
  });

  it('an episode file returns the show key its show has in the titles list, and its season', async () => {
    const titles = await get('/libraries/l1/titles');
    const card = titles.body.items.find((i: { type: string }) => i.type === 'show');
    const { body } = await get('/libraries/l1/files/f2');
    expect(body.showKey).toBe(card.key);
    expect(body.showKey).toBe(showKey({ title: SHOW, year: 1962 }));
    expect(body.season).toBe(1);
  });

  it('a movie file has no show key and no season', async () => {
    const { body } = await get('/libraries/l1/files/f3');
    expect(body.showKey).toBeNull();
    expect(body.season).toBeNull();
  });

  it('a file whose latest job has no media still gets its show key from an older job', async () => {
    file('f4', '/media/tv/S02E01.mkv', 700);
    job('j4a', 'f4', { state: 'failed', queuedAt: 6, media: media({ season: null, episode: 1 }) });
    job('j4b', 'f4', { state: 'done', queuedAt: 7 });
    const { body } = await get('/libraries/l1/files/f4');
    expect(body.file.latest.id).toBe('j4b');
    expect(body.showKey).toBe(showKey({ title: SHOW, year: 1962 }));
    expect(body.season).toBe('none');
  });

  it('a file the latest job did not replace shows its own probe as now and no before', async () => {
    const { body } = await get('/libraries/l1/files/f2');
    expect(body.now).toMatchObject({ sizeBytes: 800, streams: [{ codec: 'h264' }] });
    expect(body.before).toBeNull();
    expect(body.file.originalBytes).toBeNull();
  });

  it('a gone file still opens with gone: true', async () => {
    t.db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(10).toISOString(), 'f2');
    const { status, body } = await get('/libraries/l1/files/f2');
    expect(status).toBe(200);
    expect(body.file).toMatchObject({ id: 'f2', gone: true });
    const list = await get('/libraries/l1/files');
    expect(list.body.files.map((f: { id: string }) => f.id)).not.toContain('f2');
  });

  it('a restored file shows its original probe as now', async () => {
    insertRestore(t.db, {
      id: 'x1',
      jobId: 'j1b',
      restoredAt: at(20).toISOString(),
      restoredBy: 'u',
      sidecarPaths: [],
    });
    const { body } = await get('/libraries/l1/files/f1');
    expect(body.file).toMatchObject({ sizeBytes: 1000, originalBytes: null });
    expect(body.now).toMatchObject({ sizeBytes: 1000, streams: [{ codec: 'h264' }] });
    expect(body.before).toBeNull();
  });

  it('a replaced file with no output probe (an older replace) has no now, not the original’s probe', async () => {
    t.db.prepare('UPDATE job_results SET output_probe = NULL WHERE job_id = ?').run('j1b');
    const { status, body } = await get('/libraries/l1/files/f1');
    expect(status).toBe(200);
    expect(body.now).toBeNull();
    expect(body.before).toMatchObject({ sizeBytes: 1000, streams: [{ codec: 'h264' }] });
    expect(body.file).toMatchObject({ sizeBytes: 600, originalBytes: 1000 });
  });

  it('a file replaced from outside and queued before its probe has no now, not the old probe', async () => {
    const before = await get('/libraries/l1/files/f2');
    expect(before.body.now).toMatchObject({ sizeBytes: 800 });
    upsertFile(
      t.db,
      {
        libraryId: 'l1',
        path: '/media/tv/S01E02.mkv',
        fingerprint: { sizeBytes: 2000, mtimeMs: 9, ino: 9, dev: 1, nlink: 1 },
        lastProbe: null,
      },
      at(10),
    );
    const { status, body } = await get('/libraries/l1/files/f2');
    expect(status).toBe(200);
    expect(body.file).toMatchObject({ sizeBytes: 2000, originalBytes: null });
    expect(body.now).toBeNull();
  });

  it('a corrupt stored file probe reads as no probe, not a server error', async () => {
    t.db.prepare('UPDATE files SET last_probe = ? WHERE id = ?').run('{"streams":[', 'f2');
    const { status, body } = await get('/libraries/l1/files/f2');
    expect(status).toBe(200);
    expect(body.now).toBeNull();
    expect(body.file).toMatchObject({ id: 'f2' });
  });

  it('NOT_FOUND for an unknown library, a deleted library, another library’s file and an unknown show key', async () => {
    const key = showKey({ title: SHOW, year: 1962 });
    const missing = [
      '/libraries/nope/titles',
      '/libraries/nope/files',
      '/libraries/nope/files/f1',
      `/libraries/nope/seasons?show=${key}`,
      '/libraries/l1/files/f9',
      '/libraries/l1/files/unknown',
      `/libraries/l1/seasons?show=${showKey({ title: 'Skyward', year: 1978 })}`,
      '/libraries/l1/seasons?show=%25%25',
      '/libraries/l1/files?show=%25%25',
      `/libraries/l1/files?show=${showKey({ title: 'Skyward', year: 1978 })}`,
    ];
    for (const path of missing) {
      const res = await get(path);
      expect([path, res.status, res.body.code]).toEqual([path, 404, 'NOT_FOUND']);
    }
    softDeleteLibrary(t.db, 'l2', now);
    for (const path of ['/libraries/l2/titles', '/libraries/l2/files', '/libraries/l2/files/f9']) {
      expect((await get(path)).status).toBe(404);
    }
  });

  it('a show only an older job named is NOT_FOUND for files as for seasons; a current show with no hit is an empty page', async () => {
    file('f4', '/media/tv/S01E03.mkv', 700);
    job('j4a', 'f4', { state: 'done', queuedAt: 6, media: media({ title: 'Old', episode: 3 }) });
    job('j4b', 'f4', { state: 'done', queuedAt: 7, media: media({ episode: 3 }) });
    const old = showKey({ title: 'Old', year: 1962 });
    for (const path of [`/libraries/l1/files?show=${old}`, `/libraries/l1/seasons?show=${old}`]) {
      const res = await get(path);
      expect([path, res.status, res.body.code]).toEqual([path, 404, 'NOT_FOUND']);
    }
    const key = showKey({ title: SHOW, year: 1962 });
    for (const path of [
      `/libraries/l1/files?show=${key}&season=9`,
      `/libraries/l1/files?show=${key}&search=zzz`,
    ]) {
      const res = await get(path);
      expect([path, res.status, res.body]).toEqual([path, 200, { files: [], total: 0 }]);
    }
  });

  it('a read token can list; a token without read cannot', async () => {
    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect(
      (await send(t, 'GET', '/libraries/l1/files', { headers: bearer(read.token) })).status,
    ).toBe(200);
    const create = await createToken(t, s, { name: 'ci', scopes: ['jobs:create'] });
    expect(
      (await send(t, 'GET', '/libraries/l1/files', { headers: bearer(create.token) })).status,
    ).toBe(403);
  });
});

describe('damaged files (the library health page)', () => {
  /** f4 and f5 kept as damaged (f5 later), f6 damaged then fine, f7 damaged and gone. */
  function damagedFiles(): void {
    const damaged = { sourceDamaged: true };
    file('f4', '/media/tv/Lanternfish.mkv', 400);
    job('j4', 'f4', { state: 'kept_original', queuedAt: 6, result: damaged });
    file('f5', '/media/tv/S01E05.mkv', 400);
    job('j5', 'f5', { state: 'kept_original', queuedAt: 8, result: damaged });
    file('f6', '/media/tv/S01E06.mkv', 400);
    job('j6a', 'f6', { state: 'kept_original', queuedAt: 6, result: damaged });
    job('j6b', 'f6', { state: 'done', queuedAt: 7, result: {} });
    file('f7', '/media/tv/S01E07.mkv', 400);
    job('j7', 'f7', { state: 'kept_original', queuedAt: 6, result: damaged });
    t.db.prepare('UPDATE files SET gone_at = ? WHERE id = ?').run(at(9).toISOString(), 'f7');
  }

  it('GET /libraries/:id/files?damaged=true lists the present files whose latest job found the source damaged', async () => {
    damagedFiles();
    const { status, body } = await get('/libraries/l1/files?damaged=true&sort=lastRun&desc=true');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.files.map((f: { id: string }) => f.id)).toEqual(['f5', 'f4']);
    expect(body.files[0]).toMatchObject({
      latest: { id: 'j5', state: 'kept_original', result: { sourceDamaged: true } },
    });
    // Without the filter every listed file is there, damaged or not.
    expect((await get('/libraries/l1/files')).body.total).toBe(6);
    expect((await get('/libraries/l1/files?damaged=false')).body.total).toBe(6);
    expect((await get('/libraries/l2/files?damaged=true')).body).toEqual({ files: [], total: 0 });
  });

  it('GET /libraries/:id counts the damaged files the health page lists', async () => {
    expect((await get('/libraries/l1')).body).toMatchObject({ damagedCount: 0 });
    damagedFiles();
    const { body } = await get('/libraries/l1');
    expect(body.damagedCount).toBe(2);
    expect(body.damagedCount).toBe((await get('/libraries/l1/files?damaged=true')).body.total);
    expect((await get('/libraries/l2')).body.damagedCount).toBe(0);
  });

  it('a library with no feeder, or one without a Replace damaged file step, has no replace steps', async () => {
    expect((await get('/libraries/l1')).body.replaceDamaged).toEqual([]);
    setActiveVersion(t.db, 'w1', 1, 'u', now, 'l1');
    expect((await get('/libraries/l1')).body).toMatchObject({
      feeds: { workflowId: 'w1' },
      replaceDamaged: [],
    });
  });

  describe('with a Replace damaged file plugin step', () => {
    const SOURCE = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
    const replaceDamaged = (type: string, title: string) =>
      defineNode({
        type,
        version: 1,
        kind: 'finish',
        finishPhase: 'library-manager',
        damagedOnly: true,
        title,
        description: 'Asks the media manager for a new copy.',
        icon: 'bell',
        inputs: [filePort],
        outputs: [],
        settings: z.object({}),
        async finish() {
          return { actions: [], reason: 'would ask for a new copy' };
        },
      });
    let down: string | null;

    beforeEach(async () => {
      await t.close();
      down = null;
      t = createTestApp({
        start: now,
        nodes: [
          ...testRegistry().list(),
          {
            def: replaceDamaged('example:replace-damaged', 'Replace damaged file (Example)'),
            source: SOURCE,
          },
          {
            def: replaceDamaged('other:replace-damaged', 'Replace damaged file (Other)'),
            source: { ...SOURCE, name: 'other' },
            unavailable: () => down,
          },
        ],
      });
      s = await login(t);
      insertLibrary(
        t.db,
        {
          id: 'l1',
          name: 'Movies',
          path: '/media/movies',
          recycleFolder: null,
          processHardlinked: false,
        },
        now,
      );
    });

    function feeder(nodes: NodeInstance[], libraryId = 'l1'): void {
      insertWorkflow(
        t.db,
        { id: 'w2', kind: 'workflow', name: 'Check', graph: mainGraph(nodes), createdBy: 'u' },
        now,
      );
      setActiveVersion(t.db, 'w2', 1, 'u', now, libraryId);
    }

    it("names the steps of the feeder's active version whose plugin is running", async () => {
      feeder([node('a', 'example:replace-damaged'), node('b', 'other:replace-damaged')]);
      expect((await get('/libraries/l1')).body.replaceDamaged).toEqual([
        'Replace damaged file (Example)',
        'Replace damaged file (Other)',
      ]);
      down = 'the plugin is stopped';
      expect((await get('/libraries/l1')).body.replaceDamaged).toEqual([
        'Replace damaged file (Example)',
      ]);
    });

    it('leaves out a bypassed step, and a step of a workflow that is not active for this library', async () => {
      feeder([{ ...node('a', 'example:replace-damaged'), bypassed: true }]);
      expect((await get('/libraries/l1')).body.replaceDamaged).toEqual([]);
      insertWorkflow(
        t.db,
        {
          id: 'w3',
          kind: 'workflow',
          name: 'Inactive',
          graph: mainGraph([node('a', 'example:replace-damaged')]),
          createdBy: 'u',
        },
        now,
      );
      expect((await get('/libraries/l1')).body.replaceDamaged).toEqual([]);
    });
  });
});
