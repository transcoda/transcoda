import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { softDeleteLibrary } from '../../db/repos/libraries.ts';
import { filePathsOf, showKey } from '../../db/repos/library-files.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../engine/fs-ops.ts';
import { FakeSpawner } from '../../engine/process.ts';
import { packetRows } from '../../engine/test-helpers.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';
import { chain, node } from '../../workflows/test-helpers.ts';

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

const exec: Exec = async (_file, args) => {
  if (args.includes('-show_format')) {
    return {
      stdout: JSON.stringify({
        format: {
          format_name: 'matroska,webm',
          duration: '60.000000',
          size: '1000',
          start_time: '0.000000',
        },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'hevc', disposition: { default: 1 } },
          { index: 1, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
        ],
      }),
      stderr: '',
    };
  }
  if (args.includes('packet=stream_index,pts_time,duration_time'))
    return { stdout: packetRows('59.96,0.04'), stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: packetRows('55.0,1000,K__'), stderr: '' };
  return { stdout: '', stderr: '' };
};

const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };
const SHOW = 'The Beverly Hillbillies';
const OTHER_SHOW = 'Superman';

let base: string;
let root: string;
let root2: string;
let t: TestApp;
let s: Session;
let spawner: FakeSpawner;
let lib: string;
let lib2: string;
let wf: string;
/** file id by relative path, per library. */
const ids: Record<string, string> = {};

const count = (table: 'jobs' | 'runs'): number =>
  t.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
const post = (path: string, body: Record<string, unknown>, headers = asSession(s, true)) =>
  send(t, 'POST', path, { body, headers });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;

async function mkFile(dir: string, rel: string): Promise<string> {
  const p = join(dir, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, Buffer.alloc(1000, 7));
  return p;
}

/** Gives the file a (failed) job through the queue route, then the show media of an episode. */
async function seed(
  libraryId: string,
  dir: string,
  rel: string,
  media?: { title: string; season: number; episode: number },
): Promise<void> {
  const p = await mkFile(dir, rel);
  const res = await post('/jobs', { path: p, workflowId: wf, force: true });
  expect(res.status).toBe(200);
  const { jobIds } = await json<{ jobIds: string[] }>(res);
  const jobId = jobIds[0] as string;
  if (media) {
    const stored = {
      kind: 'episode',
      title: media.title,
      year: 1962,
      season: media.season,
      episode: media.episode,
      episodeTitle: null,
      source: 'sidecar',
      posterPath: null,
    };
    t.db.prepare('UPDATE jobs SET media = ? WHERE id = ?').run(JSON.stringify(stored), jobId);
  }
  // Failed, so the file is no longer held by an active run and may be queued again.
  t.db.prepare("UPDATE jobs SET state = 'failed', finished_at = queued_at WHERE id = ?").run(jobId);
  ids[`${libraryId}:${rel}`] = t.db
    .prepare('SELECT file_id FROM jobs WHERE id = ?')
    .pluck()
    .get(jobId) as string;
}

beforeEach(async () => {
  base = await tempDir('rpc-queue-files-');
  root = join(base, 'lib');
  root2 = join(base, 'lib2');
  await mkdir(root, { recursive: true });
  await mkdir(root2, { recursive: true });
  spawner = new FakeSpawner();
  t = createTestApp({
    config: {
      configDir: join(base, 'config'),
      transcodeDir: join(base, 'transcode'),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    },
    capabilities: caps,
    spawner,
    fsOps,
    exec,
    heartbeatMs: 10,
  });
  await t.deps.engine.start();
  s = await login(t);
  // Nothing starts while the queue is paused, so queued jobs stay as they are.
  expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(200);
  lib = ((await json(await post('/libraries', { name: 'TV', path: root }))).id as string) ?? '';
  lib2 =
    ((await json(await post('/libraries', { name: 'Other', path: root2 }))).id as string) ?? '';
  const created = t.deps.workflows.create({ name: 'Encode', kind: 'workflow' }, 'u');
  wf = created.id;
  t.deps.workflows.save(
    {
      id: wf,
      baseVersion: 1,
      graph: chain(
        'workflow',
        node('in', 'core:input-library', { libraryId: lib }),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    },
    'u',
  );
  expect(t.deps.workflows.activate(wf, 2, 'u').kind).toBe('ok');

  await seed(lib, root, 'S01E01.mkv', { title: SHOW, season: 1, episode: 1 });
  await seed(lib, root, 'S01E02.mkv', { title: SHOW, season: 1, episode: 2 });
  await seed(lib, root, 'S02E01.mkv', { title: SHOW, season: 2, episode: 1 });
  await seed(lib, root, 'Super.mkv', { title: OTHER_SHOW, season: 1, episode: 1 });
  await seed(lib, root, 'Movie.mkv');
  await seed(lib2, root2, 'Elsewhere.mkv');
});

afterEach(async () => {
  await t.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

const showOf = (title: string) => showKey({ title, year: 1962 });
const pathsOfNewestRun = (): string[] => {
  const run = t.db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1').pluck().get();
  return (
    t.db
      .prepare('SELECT path FROM jobs WHERE run_id = ? ORDER BY path')
      .pluck()
      .all(run) as string[]
  ).map((p) => p.slice(root.length + 1));
};

describe('jobs.queueFiles', () => {
  it('POST /jobs/queue-files with fileIds queues one run and answers like jobs.queue', async () => {
    const runs = count('runs');
    const jobs = count('jobs');
    const res = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: [ids[`${lib}:Movie.mkv`]],
      workflowId: wf,
    });
    expect(res.status).toBe(200);
    const body = await json<{ runId: string; jobIds: string[] }>(res);
    expect(Object.keys(body).sort()).toEqual(
      ['dryRun', 'jobIds', 'note', 'runId', 'testEncode', 'workflowVersion'].sort(),
    );
    expect(body).toMatchObject({
      dryRun: false,
      note: null,
      workflowVersion: 2,
      testEncode: false,
    });
    expect(body.jobIds).toHaveLength(1);
    expect(count('runs')).toBe(runs + 1);
    expect(count('jobs')).toBe(jobs + 1);
    const row = t.db
      .prepare('SELECT run_id, path, state FROM jobs WHERE id = ?')
      .get(body.jobIds[0]) as { run_id: string; path: string; state: string };
    expect(row).toMatchObject({
      run_id: body.runId,
      path: join(root, 'Movie.mkv'),
      state: 'queued',
    });
  });

  it('paths are queued; one outside the root rejects the whole request', async () => {
    const jobs = count('jobs');
    const ok = await post('/jobs/queue-files', {
      libraryId: lib,
      paths: [join(root, 'Movie.mkv'), join(root, 'S01E01.mkv')],
      workflowId: wf,
    });
    expect(ok.status).toBe(200);
    expect((await json<{ jobIds: string[] }>(ok)).jobIds).toHaveLength(2);
    const before = count('jobs');
    expect(before).toBe(jobs + 2);
    const out = await post('/jobs/queue-files', {
      libraryId: lib,
      paths: [join(root, 'S01E02.mkv'), join(root2, 'Elsewhere.mkv')],
      workflowId: wf,
    });
    expect(out.status).toBe(400);
    // The path refused is the offending one, not the library id.
    expect(await json(out)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { reason: 'outside library root', path: join(root2, 'Elsewhere.mkv') },
    });
    expect(count('jobs')).toBe(before);
  });

  it('fileIds of another library are not queued: nothing left is 404', async () => {
    const jobs = count('jobs');
    const runs = count('runs');
    const res = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: [ids[`${lib2}:Elsewhere.mkv`]],
      workflowId: wf,
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: 'NOT_FOUND' });
    expect(count('jobs')).toBe(jobs);
    expect(count('runs')).toBe(runs);
  });

  it('unknown ids are not queued; the known one beside them is', async () => {
    const jobs = count('jobs');
    const unknown = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: ['nope'],
      workflowId: wf,
    });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ code: 'NOT_FOUND' });
    expect(count('jobs')).toBe(jobs);
    const mixed = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: ['nope', ids[`${lib2}:Elsewhere.mkv`], ids[`${lib}:Movie.mkv`]],
      workflowId: wf,
    });
    expect(mixed.status).toBe(200);
    expect(count('jobs')).toBe(jobs + 1);
    expect(pathsOfNewestRun()).toEqual(['Movie.mkv']);
  });

  it('a show selection queues every listed episode of that show', async () => {
    const res = await post('/jobs/queue-files', {
      libraryId: lib,
      show: showOf(SHOW),
      workflowId: wf,
    });
    expect(res.status).toBe(200);
    expect((await json<{ jobIds: string[] }>(res)).jobIds).toHaveLength(3);
    expect(pathsOfNewestRun()).toEqual(['S01E01.mkv', 'S01E02.mkv', 'S02E01.mkv']);
  });

  it('a season with no listed file is 404 and queues nothing', async () => {
    const jobs = count('jobs');
    const res = await post('/jobs/queue-files', {
      libraryId: lib,
      show: showOf(SHOW),
      season: '7',
      workflowId: wf,
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: 'NOT_FOUND' });
    expect(count('jobs')).toBe(jobs);
  });

  it('a season selection queues only that season, and a gone file is left out', async () => {
    t.db
      .prepare("UPDATE files SET gone_at = '2026-11-01T00:00:00.000Z' WHERE id = ?")
      .run(ids[`${lib}:S01E02.mkv`]);
    const res = await post('/jobs/queue-files', {
      libraryId: lib,
      show: showOf(SHOW),
      season: '1',
      workflowId: wf,
    });
    expect(res.status).toBe(200);
    expect(pathsOfNewestRun()).toEqual(['S01E01.mkv']);
  });

  it('a show key that does not parse, or names no show here, is 404 and queues nothing', async () => {
    const jobs = count('jobs');
    for (const show of [
      '%%%',
      Buffer.from('[1,2]').toString('base64url'),
      showOf('Sherlock Jr.'),
    ]) {
      const res = await post('/jobs/queue-files', { libraryId: lib, show, workflowId: wf });
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(count('jobs')).toBe(jobs);
  });

  it('an unknown workflow, an unknown library and a deleted library are 404; nothing is queued', async () => {
    const jobs = count('jobs');
    const noWf = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: [ids[`${lib}:Movie.mkv`]],
      workflowId: 'nope',
    });
    expect(noWf.status).toBe(404);
    for (const path of ['/jobs/queue-files', '/jobs/queue-files/preview']) {
      const noLib = await post(path, {
        libraryId: 'nope',
        paths: [join(root, 'Movie.mkv')],
        workflowId: wf,
      });
      expect([path, noLib.status]).toEqual([path, 404]);
      expect(await json(noLib)).toMatchObject({ code: 'NOT_FOUND' });
    }
    softDeleteLibrary(t.db, lib2, new Date());
    for (const sel of [
      { fileIds: [ids[`${lib2}:Elsewhere.mkv`]] },
      { paths: [join(root2, 'Elsewhere.mkv')] },
    ]) {
      const gone = await post('/jobs/queue-files', { libraryId: lib2, ...sel, workflowId: wf });
      expect(gone.status).toBe(404);
      expect(await json(gone)).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(count('jobs')).toBe(jobs);
  });

  it('a library whose folder is gone is 412 LIBRARY_UNREACHABLE with its path; nothing is queued', async () => {
    const jobs = count('jobs');
    await rename(root, `${root}-unmounted`);
    try {
      for (const path of ['/jobs/queue-files', '/jobs/queue-files/preview']) {
        for (const sel of [
          { fileIds: [ids[`${lib}:Movie.mkv`]] },
          { paths: [join(root, 'Movie.mkv')] },
        ]) {
          const res = await post(path, { libraryId: lib, ...sel, workflowId: wf });
          expect([path, res.status]).toEqual([path, 412]);
          expect(await json(res)).toMatchObject({
            code: 'LIBRARY_UNREACHABLE',
            data: { path: root },
          });
        }
      }
    } finally {
      await rename(`${root}-unmounted`, root);
    }
    expect(count('jobs')).toBe(jobs);
  });

  it('refuses a request with none or several of fileIds, paths and show', async () => {
    const jobs = count('jobs');
    const both = await post('/jobs/queue-files', {
      libraryId: lib,
      fileIds: [ids[`${lib}:Movie.mkv`]],
      paths: [join(root, 'Movie.mkv')],
      workflowId: wf,
    });
    expect(both.status).toBe(400);
    const none = await post('/jobs/queue-files', { libraryId: lib, workflowId: wf });
    expect(none.status).toBe(400);
    expect(count('jobs')).toBe(jobs);
  });

  it('a season without a show is refused', async () => {
    const jobs = count('jobs');
    for (const path of ['/jobs/queue-files', '/jobs/queue-files/preview']) {
      const res = await post(path, {
        libraryId: lib,
        fileIds: [ids[`${lib}:S01E01.mkv`]],
        season: '1',
        workflowId: wf,
      });
      expect([path, res.status]).toEqual([path, 400]);
    }
    expect(count('jobs')).toBe(jobs);
  });

  it('a plan token can queue a dry run but not a real one; a read token cannot queue', async () => {
    const body = { libraryId: lib, fileIds: [ids[`${lib}:Movie.mkv`]], workflowId: wf };
    const plan = await createToken(t, s, { name: 'planner', scopes: ['plan'] });
    const dry = await post('/jobs/queue-files', { ...body, dryRun: true }, bearer(plan.token));
    expect(dry.status).toBe(200);
    expect(await json(dry)).toMatchObject({ dryRun: true });
    const jobs = count('jobs');
    const runs = count('runs');
    const real = await post('/jobs/queue-files', { ...body, dryRun: false }, bearer(plan.token));
    expect(real.status).toBe(403);
    expect(await json(real)).toMatchObject({ code: 'FORBIDDEN' });
    const implicit = await post('/jobs/queue-files', body, bearer(plan.token));
    expect(implicit.status).toBe(403);

    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    for (const dryRun of [true, false]) {
      expect(
        (await post('/jobs/queue-files', { ...body, dryRun }, bearer(read.token))).status,
      ).toBe(403);
    }
    expect(count('jobs')).toBe(jobs);
    expect(count('runs')).toBe(runs);

    const create = await createToken(t, s, { name: 'ci', scopes: ['jobs:create'] });
    const ok = await post('/jobs/queue-files', body, bearer(create.token));
    expect(ok.status).toBe(200);
    expect(count('jobs')).toBe(jobs + 1);
  });

  it('a session needs the CSRF token', async () => {
    const jobs = count('jobs');
    const body = { libraryId: lib, fileIds: [ids[`${lib}:Movie.mkv`]], workflowId: wf };
    for (const path of ['/jobs/queue-files', '/jobs/queue-files/preview']) {
      const res = await post(path, body, asSession(s, false));
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'CSRF_FAILED' });
    }
    expect(count('jobs')).toBe(jobs);
  });
});

describe('jobs.queueFilesPreview', () => {
  it('counts notFound for unknown ids and other libraries, and writes nothing', async () => {
    const jobs = count('jobs');
    const runs = count('runs');
    const res = await post('/jobs/queue-files/preview', {
      libraryId: lib,
      fileIds: [ids[`${lib}:Movie.mkv`], 'nope', ids[`${lib2}:Elsewhere.mkv`]],
      workflowId: wf,
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, number | boolean>>(res);
    expect(Object.keys(body).sort()).toEqual(
      [
        'alreadyHandled',
        'dryRun',
        'heldByAnotherRun',
        'notFound',
        'skipped',
        'willRun',
        'workflowVersion',
      ].sort(),
    );
    expect(body).toMatchObject({
      notFound: 2,
      willRun: 1,
      alreadyHandled: 0,
      heldByAnotherRun: 0,
      skipped: 0,
      workflowVersion: 2,
      dryRun: false,
    });
    expect(count('jobs')).toBe(jobs);
    expect(count('runs')).toBe(runs);
  });

  it('a show selection counts its files; nothing found is 404', async () => {
    const jobs = count('jobs');
    const show = await post('/jobs/queue-files/preview', {
      libraryId: lib,
      show: showOf(SHOW),
      season: '1',
      workflowId: wf,
    });
    expect(await json(show)).toMatchObject({ willRun: 2, notFound: 0 });
    const none = await post('/jobs/queue-files/preview', {
      libraryId: lib,
      fileIds: ['nope'],
      workflowId: wf,
    });
    expect(none.status).toBe(404);
    expect(await json(none)).toMatchObject({ code: 'NOT_FOUND' });
    const badKey = await post('/jobs/queue-files/preview', {
      libraryId: lib,
      show: '%%%',
      workflowId: wf,
    });
    expect(badKey.status).toBe(404);
    expect(count('jobs')).toBe(jobs);
  });

  it('a plan token may preview a dry run only; a read token may not preview', async () => {
    const body = { libraryId: lib, fileIds: [ids[`${lib}:Movie.mkv`]], workflowId: wf };
    const plan = await createToken(t, s, { name: 'planner', scopes: ['plan'] });
    const dry = await post(
      '/jobs/queue-files/preview',
      { ...body, dryRun: true },
      bearer(plan.token),
    );
    expect(dry.status).toBe(200);
    expect(await json(dry)).toMatchObject({ dryRun: true, willRun: 1 });
    const real = await post('/jobs/queue-files/preview', body, bearer(plan.token));
    expect(real.status).toBe(403);
    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect((await post('/jobs/queue-files/preview', body, bearer(read.token))).status).toBe(403);
  });
});

describe('filePathsOf', () => {
  it('names only this library, counts the rest as notFound and drops repeated ids', () => {
    const r = filePathsOf(t.db, lib, {
      fileIds: [
        ids[`${lib}:Movie.mkv`] as string,
        ids[`${lib}:Movie.mkv`] as string,
        ids[`${lib2}:Elsewhere.mkv`] as string,
        'nope',
      ],
    });
    expect(r).toEqual({ paths: [join(root, 'Movie.mkv')], notFound: 2 });
  });

  it('a show or season takes its listed files, not gone ones, and not another show', () => {
    t.db
      .prepare("UPDATE files SET gone_at = '2026-11-01T00:00:00.000Z' WHERE id = ?")
      .run(ids[`${lib}:S02E01.mkv`]);
    const all = filePathsOf(t.db, lib, { show: { title: SHOW, year: 1962 } });
    expect(all.paths.map((p) => p.slice(root.length + 1)).sort()).toEqual([
      'S01E01.mkv',
      'S01E02.mkv',
    ]);
    expect(all.notFound).toBe(0);
    expect(filePathsOf(t.db, lib, { show: { title: SHOW, year: 1962 }, season: 2 }).paths).toEqual(
      [],
    );
    expect(filePathsOf(t.db, lib2, { show: { title: SHOW, year: 1962 } }).paths).toEqual([]);
    expect(
      filePathsOf(t.db, lib, { show: { title: SHOW.toLowerCase(), year: 1962 } }).paths,
    ).toEqual([]);
  });
});
