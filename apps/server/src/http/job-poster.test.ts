import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph, type StoredJobMedia } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertJob } from '../db/repos/jobs.ts';
import { insertLibrary, softDeleteLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { tempDir } from '../engine/fixtures.ts';
import { PosterStore, type ThumbRunner } from '../engine/poster-store.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, HOST, login, type Session, send } from '../test-http.ts';

/** Starts with a JPEG signature, so the store's source check passes. */
const SOURCE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]);

let base: string;
let t: TestApp;
let s: Session;
let thumbSource: string;

const url = (id: string) => `/jobs/${id}/poster`;

function media(posterPath: string | null): StoredJobMedia {
  return {
    kind: 'movie',
    title: 'Sherlock Jr.',
    year: 1924,
    season: null,
    episode: null,
    episodeTitle: null,
    source: 'sidecar',
    posterPath,
  };
}

function job(id: string, posterPath: string | null): void {
  insertJob(
    t.db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: join(base, 'lib', `${id}.mkv`),
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
      media: media(posterPath),
    },
    t.clock.now(),
  );
}

/** A runner that "builds" the thumbnail by copying a fixture JPEG. */
const copyRunner: ThumbRunner = async (o) => {
  await copyFile(thumbSource, o.outPath);
};

beforeEach(async () => {
  base = await tempDir('job-poster-route-');
  t = createTestApp({ config: { configDir: join(base, 'config') } });
  s = await login(t);
  thumbSource = join(base, 'thumb.jpg');
  await writeFile(thumbSource, THUMB);
  Object.assign(t.deps.engine, {
    posters: new PosterStore({
      dir: join(base, 'config', 'posters'),
      ffmpegPath: 'ffmpeg',
      now: t.clock.now,
      log: t.deps.log,
      run: copyRunner,
    }),
  });
  insertWorkflow(
    t.db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    t.clock.now(),
  );
  await mkdir(join(base, 'lib'), { recursive: true });
  insertLibrary(
    t.db,
    {
      id: 'l1',
      name: 'Movies',
      path: join(base, 'lib'),
      recycleFolder: null,
      processHardlinked: false,
    },
    t.clock.now(),
  );
  insertRun(
    t.db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: join(base, 'lib'),
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    t.clock.now(),
  );
  await writeFile(join(base, 'lib', 'poster.jpg'), SOURCE);
  job('a', join(base, 'lib', 'poster.jpg'));
  job('nop', null);
  job('gone', join(base, 'lib', 'missing.jpg'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await rm(base, { recursive: true, force: true });
});

describe('GET /jobs/{id}/poster', () => {
  it('serves the thumbnail as a private cacheable JPEG with an etag', async () => {
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('etag')).toMatch(/^"\d+-\d+"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(THUMB)).toBe(true);
  });

  it('a matching if-none-match → 304 with no body', async () => {
    const first = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    const etag = first.headers.get('etag') ?? '';
    const res = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), 'if-none-match': etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('HEAD → 200 with the headers and no body', async () => {
    const res = await t.app.request(`/api/v1${url('a')}`, {
      method: 'HEAD',
      headers: { host: HOST, ...asSession(s, false) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  it('unknown job, no poster, a gone poster file → 404', async () => {
    for (const id of ['missing', 'nop', 'gone']) {
      const res = await send(t, 'GET', url(id), { headers: asSession(s, false) });
      expect(res.status, id).toBe(404);
    }
  });

  it('a soft-deleted library with no cached thumbnail → 404', async () => {
    softDeleteLibrary(t.db, 'l1', t.clock.now());
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(404);
  });

  it('a store that has nothing → 404, never a 500', async () => {
    vi.spyOn(t.deps.engine, 'jobPoster').mockResolvedValue(null);
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(404);
  });

  it('a thumbnail that vanished before it was opened → 404', async () => {
    vi.spyOn(t.deps.engine, 'jobPoster').mockResolvedValue({
      path: join(base, 'nowhere.jpg'),
      size: 10,
      mtimeMs: 1,
    });
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(404);
  });

  it('a token → 403, no session → 401, cross-site → 403', async () => {
    const { token } = await createToken(t, s);
    const byToken = await send(t, 'GET', url('a'), { headers: bearer(token) });
    expect(byToken.status).toBe(403);
    expect(await byToken.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Posters are shown in the UI',
    });
    const none = await send(t, 'GET', url('a'));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    const cross = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: 'CSRF_FAILED' });
  });
});
