import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import type { JobState } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob, type JobRow, updateJob } from '../../db/repos/jobs.ts';
import { setSetting } from '../../db/repos/settings.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../../engine/fs-ops.ts';
import { FakeSpawner } from '../../engine/process.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';
import { chain, node } from '../../workflows/test-helpers.ts';
import { redactGraph } from '../redact.ts';

/** How long `until` waits; well above any healthy run, below the raised test timeout. */
const UNTIL_MS = 10_000;
vi.setConfig({ testTimeout: 30_000 });

const caps: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '9.0.2',
  encoders: ['aac', 'libx264', 'libx265'],
  hwaccels: [],
  filters: ['pan'],
};

/**
 * ffprobe answers for a 60 s hevc+aac mkv (h264 once encoded into the temp dir), packets that end
 * at 60 s, a keyframe at 55 s; ffmpeg runs succeed quietly.
 */
const exec: Exec = async (_file, args) => {
  const output = (args.at(-1) as string).startsWith(transcodeDir);
  if (args.includes('-show_format')) {
    const json = {
      format: {
        format_name: 'matroska,webm',
        duration: '60.000000',
        size: '1000',
        start_time: '0.000000',
      },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: output ? 'h264' : 'hevc',
          disposition: { default: 1 },
        },
        {
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          disposition: { default: 1 },
          tags: { language: 'eng' },
        },
      ],
    };
    return { stdout: JSON.stringify(json), stderr: '' };
  }
  if (args.includes('packet=pts_time,duration_time')) return { stdout: '59.96,0.04\n', stderr: '' };
  if (args.includes('-read_intervals')) return { stdout: '55.0,1000,K__\n', stderr: '' };
  return { stdout: '', stderr: '' };
};

const SECRET = 'hook-secret-7f3a';
const fsOps: FsOps = { ...nodeFsOps, statfs: async () => ({ bavail: 1e9, bsize: 4096 }) };

let base: string;
let root: string;
let outside: string;
let configDir: string;
let transcodeDir: string;
let spawner: FakeSpawner;
let t: TestApp;
let s: Session;

beforeEach(async () => {
  base = await tempDir('rpc-engine-');
  root = join(base, 'lib');
  outside = join(base, 'outside');
  configDir = join(base, 'config');
  transcodeDir = join(base, 'transcode');
  await mkdir(join(root, 'Show', 'Season 1'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'a.mkv'), Buffer.alloc(1000, 7));
  await writeFile(join(outside, 'x.mkv'), Buffer.alloc(1000, 7));
  spawner = new FakeSpawner();
  t = createTestApp({
    config: { configDir, transcodeDir, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
    capabilities: caps,
    spawner,
    fsOps,
    exec,
    heartbeatMs: 10,
  });
  await t.deps.engine.start();
  s = await login(t);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await t.deps.engine.stop();
  await rm(base, { recursive: true, force: true });
});

/**
 * Polls `pred` every 5 ms for up to {@link UNTIL_MS} (a fast run costs nothing; a loaded machine,
 * e.g. `pnpm check` with the real-ffmpeg suites in parallel, gets time). The test timeout is raised
 * to match (vi.setConfig below).
 */
async function until(what: string, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + UNTIL_MS;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const row = (id: string): JobRow => findJob(t.db, id) as JobRow;
const isFinal = (id: string) =>
  (['done', 'failed', 'cancelled', 'dry_run', 'kept_original'] as JobState[]).includes(
    row(id).state,
  );

/**
 * An enabled encode workflow (in → encode h264 → replace → optional notify). With `libraryId` its
 * input is a Library input naming that library, so it feeds the library.
 */
function encodeWorkflow(opts: { notify?: boolean; libraryId?: string } = {}): string {
  const { id } = t.deps.workflows.create({ name: 'Encode', kind: 'workflow' }, 'u');
  const nodes = [
    opts.libraryId === undefined
      ? node('in', 'core:input-manual')
      : node('in', 'core:input-library', { libraryId: opts.libraryId }),
    node('ev', 'core:encode-video', { codec: 'h264', encoder: 'libx264', skipIf: 'never' }),
    node('ro', 'core:replace-original'),
    ...(opts.notify
      ? [node('nw', 'core:notify-webhook', { url: `https://hooks.example/${SECRET}` })]
      : []),
  ];
  t.deps.workflows.save({ id, baseVersion: 1, graph: chain('workflow', ...nodes) }, 'u');
  expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
  return id;
}

async function createLibrary(body: Record<string, unknown>): Promise<Response> {
  return send(t, 'POST', '/libraries', { body, headers: asSession(s, true) });
}

async function library(): Promise<string> {
  const res = await createLibrary({ name: 'TV', path: root });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** The TV library and the active encode workflow that feeds it (a queue without workflowId uses it). */
async function fedLibrary(opts: { notify?: boolean } = {}): Promise<{ wf: string; id: string }> {
  const id = await library();
  return { wf: encodeWorkflow({ ...opts, libraryId: id }), id };
}

async function queue(
  body: Record<string, unknown>,
  headers: Record<string, string> = asSession(s, true),
): Promise<Response> {
  return send(t, 'POST', '/jobs', { body, headers });
}

async function queued(
  body: Record<string, unknown>,
): Promise<{ runId: string; jobIds: string[]; testEncode: boolean }> {
  const res = await queue(body);
  expect(res.status).toBe(200);
  return (await res.json()) as { runId: string; jobIds: string[]; testEncode: boolean };
}

/** Finishes the latest fake ffmpeg run: writes `bytes` to its output and exits 0. */
async function finishEncode(bytes: number): Promise<void> {
  const call = spawner.calls.at(-1);
  if (!call) throw new Error('no spawn');
  await writeFile(call.args.at(-1) as string, Buffer.alloc(bytes, 1));
  await writeFile(call.logPath, 'frame=1\n');
  spawner.exit(0);
}

const get = async (path: string, headers: Record<string, string> = asSession(s, false)) =>
  send(t, 'GET', path, { headers });
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;

describe('libraries', () => {
  it('create (session) → list → update → delete; create with a missing path → 400 LIBRARY_PATH_INVALID', async () => {
    const created = await createLibrary({ name: 'TV', path: `${root}/`, recycleFolder: '.bin' });
    expect(created.status).toBe(200);
    const lib = await json(created);
    expect(lib).toMatchObject({
      name: 'TV',
      processHardlinked: false,
      verifyFullDecode: false,
      runHours: null,
      feeds: null,
    });
    expect(lib).not.toHaveProperty('deletedAt');
    expect(lib).not.toHaveProperty('defaultWorkflowId');
    const id = lib.id as string;

    const list = await json<{ libraries: { id: string }[] }>(await get('/libraries'));
    expect(list.libraries.map((l) => l.id)).toEqual([id]);
    expect((await get(`/libraries/${id}`)).status).toBe(200);

    const patched = await send(t, 'PATCH', `/libraries/${id}`, {
      body: { name: 'Shows', verifyFullDecode: true },
      headers: asSession(s, true),
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ id, name: 'Shows', verifyFullDecode: true });

    const days = [[], [], [], [], [], [], []];
    const hours = await send(t, 'PATCH', `/libraries/${id}`, {
      body: { runHours: { enabled: true, perDay: false, every: [23, 22, 0], days } },
      headers: asSession(s, true),
    });
    expect(await json(hours)).toMatchObject({
      runHours: { enabled: true, perDay: false, every: [0, 22, 23], days },
    });
    const badHour = await send(t, 'PATCH', `/libraries/${id}`, {
      body: { runHours: { enabled: true, perDay: false, every: [24], days } },
      headers: asSession(s, true),
    });
    expect(badHour.status).toBe(400);

    const rootAsRecycle = await send(t, 'PATCH', `/libraries/${id}`, {
      body: { recycleFolder: '.' },
      headers: asSession(s, true),
    });
    expect(rootAsRecycle.status).toBe(400);
    expect(await json(rootAsRecycle)).toMatchObject({
      code: 'LIBRARY_PATH_INVALID',
      data: { reason: 'the recycle folder must be a folder inside the library root' },
    });

    expect(
      (await send(t, 'DELETE', `/libraries/${id}`, { headers: asSession(s, true) })).status,
    ).toBe(200);
    expect((await get(`/libraries/${id}`)).status).toBe(404);
    expect(await json(await get('/libraries'))).toEqual({
      libraries: [],
      notices: [],
      clock: { now: expect.any(String), timeZone: expect.any(String) },
    });

    const missing = await createLibrary({ name: 'X', path: join(base, 'nope') });
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({
      code: 'LIBRARY_PATH_INVALID',
      data: { reason: 'not found' },
    });
  });

  it('defaultWorkflowId is gone: create and update with it are a 400 naming the Library input; reads carry feeds', async () => {
    const { wf, id } = await fedLibrary();
    const one = await json(await get(`/libraries/${id}`));
    expect(one).not.toHaveProperty('defaultWorkflowId');
    expect(one).toMatchObject({ feeds: { workflowId: wf } });

    const created = await createLibrary({
      name: 'X',
      path: join(base, 'other'),
      defaultWorkflowId: 'w1',
    });
    expect(created.status).toBe(400);
    expect(JSON.stringify(await json(created))).toContain('Library input');

    for (const value of ['nope', null]) {
      const patched = await send(t, 'PATCH', `/libraries/${id}`, {
        body: { defaultWorkflowId: value },
        headers: asSession(s, true),
      });
      expect(patched.status).toBe(400);
      expect(JSON.stringify(await json(patched))).toContain('Library input');
    }

    expect(t.deps.workflows.deactivate(wf).kind).toBe('ok');
    const list = await json<{ libraries: Record<string, unknown>[] }>(await get('/libraries'));
    expect(list.libraries).toEqual([expect.objectContaining({ id, feeds: null })]);
    expect(list.libraries[0]).not.toHaveProperty('defaultWorkflowId');
  });

  it('paths with NUL are a 400 before any disk access; over-long paths are PATH_REJECTED / LIBRARY_PATH_INVALID "path too long", never 500', async () => {
    const { id } = await fedLibrary();
    const nul = `${root}/a\u0000.mkv`;
    for (const res of [
      await createLibrary({ name: 'X', path: `${base}/x\u0000` }),
      await queue({ path: nul }),
      await get(`/libraries/${id}/browse?path=${encodeURIComponent('a\u0000b')}`),
    ]) {
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'BAD_REQUEST' });
    }

    const long = join(root, `${'x'.repeat(300)}.mkv`);
    const queued = await queue({ path: long });
    expect(queued.status).toBe(400);
    expect(await json(queued)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: long, reason: 'path too long' },
    });
    const browsed = await get(`/libraries/${id}/browse?path=${'y'.repeat(300)}`);
    expect(browsed.status).toBe(400);
    expect(await json(browsed)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { reason: 'path too long' },
    });
    const created = await createLibrary({ name: 'Long', path: join(base, 'z'.repeat(300)) });
    expect(created.status).toBe(400);
    expect(await json(created)).toMatchObject({
      code: 'LIBRARY_PATH_INVALID',
      data: { reason: 'path too long' },
    });
  });

  it('a library whose jobs are active cannot be deleted (409 LIBRARY_BUSY); a nested root is LIBRARY_PATH_INVALID', async () => {
    const { id } = await fedLibrary();
    await queued({ path: join(root, 'a.mkv') });
    await until('encoding', () => spawner.calls.length === 1);
    const res = await send(t, 'DELETE', `/libraries/${id}`, { headers: asSession(s, true) });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'LIBRARY_BUSY' });

    const nested = await createLibrary({ name: 'Nested', path: join(root, 'Show') });
    expect(nested.status).toBe(400);
    expect(await json(nested)).toMatchObject({
      code: 'LIBRARY_PATH_INVALID',
      data: { reason: 'overlaps library "TV"' },
    });
  });

  it('libraries.browse lists dirs and media files under the root and rejects a path outside it with PATH_REJECTED', async () => {
    await writeFile(join(root, 'Show', 'Season 1', 'e1.mkv'), Buffer.alloc(10, 1));
    await writeFile(join(root, 'notes.txt'), 'x');
    await symlink(outside, join(root, 'escape'));
    const id = await library();

    const top = await json(await get(`/libraries/${id}/browse`));
    expect(top).toMatchObject({ dirs: ['Show'], files: [{ name: 'a.mkv', sizeBytes: 1000 }] });
    const season = await json(
      await get(`/libraries/${id}/browse?path=${encodeURIComponent('Show/Season 1')}`),
    );
    expect(season).toMatchObject({ dirs: [], files: [{ name: 'e1.mkv', sizeBytes: 10 }] });

    for (const [path, reason] of [
      ['../outside', 'outside library root'],
      ['/etc', 'outside library root'],
      ['escape', 'symlink escapes root'],
    ] as const) {
      const res = await get(`/libraries/${id}/browse?path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'PATH_REJECTED', data: { path, reason } });
    }
    expect((await get(`/libraries/${id}/browse?path=nope`)).status).toBe(404);
    expect((await get('/libraries/nope/browse')).status).toBe(404);
  });

  it('libraries.browse of a folder it cannot read → 400 PATH_REJECTED "unreadable"', async () => {
    const locked = join(root, 'Locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const id = await library();
      const res = await get(`/libraries/${id}/browse?path=Locked`);
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({
        code: 'PATH_REJECTED',
        data: { path: 'Locked', reason: 'unreadable' },
      });
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe('jobs', () => {
  it('jobs.queue: a file in a library → 200 { runId, jobIds: 1 }; outside any library → 400 PATH_REJECTED; plan token may queue a dry run only (403 for a real run); read token → 403', async () => {
    const { wf } = await fedLibrary();
    // Nothing starts while the queue is paused, so the jobs stay queued for this test.
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );

    const ok = await queued({ path: join(root, 'a.mkv') });
    expect(ok.jobIds).toHaveLength(1);
    expect(row(ok.jobIds[0] as string)).toMatchObject({ runId: ok.runId, state: 'queued' });

    await symlink(join(outside, 'x.mkv'), join(root, 'leak.mkv'));
    const leak = await queue({ path: join(root, 'leak.mkv') });
    expect(leak.status).toBe(400);
    expect(await json(leak)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: join(root, 'leak.mkv'), reason: 'symlink escapes root' },
    });

    // fileOnly (Run on a file): a folder is refused; only Scan now runs a whole folder for real.
    const folder = await queue({ path: root, fileOnly: true });
    expect(folder.status).toBe(400);
    expect(await json(folder)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: root, reason: 'not a file' },
    });
    expect(
      (await queued({ path: join(root, 'a.mkv'), fileOnly: true, force: true })).jobIds,
    ).toHaveLength(1);

    const out = await queue({ path: join(outside, 'x.mkv') });
    expect(out.status).toBe(400);
    expect(await json(out)).toMatchObject({
      code: 'PATH_REJECTED',
      data: { path: join(outside, 'x.mkv'), reason: 'outside library root' },
    });

    const plan = await createToken(t, s, { name: 'diskmap', scopes: ['plan'] });
    const dry = await queue({ path: join(root, 'a.mkv'), dryRun: true }, bearer(plan.token));
    expect(dry.status).toBe(200);
    const dryJob = (await json<{ jobIds: string[] }>(dry)).jobIds[0] as string;
    expect(row(dryJob).dryRun).toBe(true);
    // `plan` is not `read`: it cannot read the job it queued (scopes are exact).
    expect((await get(`/jobs/${dryJob}`, bearer(plan.token))).status).toBe(403);
    const real = await queue({ path: join(root, 'a.mkv'), force: true }, bearer(plan.token));
    expect(real.status).toBe(403);

    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect(
      (await queue({ path: join(root, 'a.mkv'), dryRun: true }, bearer(read.token))).status,
    ).toBe(403);
    const create = await createToken(t, s, { name: 'ci', scopes: ['jobs:create'] });
    expect(
      (await queue({ path: join(root, 'a.mkv'), force: true }, bearer(create.token))).status,
    ).toBe(200);

    const noWorkflow = await queue({ path: join(root, 'a.mkv'), workflowId: 'nope' });
    expect(noWorkflow.status).toBe(404);
    expect(t.deps.workflows.deactivate(wf).kind).toBe('ok');
    const noFeeder = await queue({ path: join(root, 'a.mkv') });
    expect(noFeeder.status).toBe(400);
    expect(await json(noFeeder)).toMatchObject({ code: 'NO_FEEDING_WORKFLOW' });
  });

  it('jobs.queue: reports dryRun, note and workflowVersion; a dry run can pin a version; unknown versions are 404; a real run with nothing active becomes a dry run; a blocked active version is 422', async () => {
    const { wf } = await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');

    const real = await queue({ path: file });
    expect(real.status).toBe(200);
    expect(await json(real)).toMatchObject({ dryRun: false, note: null, workflowVersion: 2 });

    // Version 3 is newer than the active 2; a dry run without a version plans with it.
    t.deps.workflows.save(
      {
        id: wf,
        baseVersion: 2,
        graph: chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('ev', 'core:encode-video', { codec: 'hevc', encoder: 'libx265', skipIf: 'never' }),
          node('ro', 'core:replace-original'),
        ),
      },
      'u',
    );
    const newest = await queue({ path: file, dryRun: true });
    expect(await json(newest)).toMatchObject({ dryRun: true, workflowVersion: 3 });

    const pinned = await queue({ path: file, dryRun: true, workflowVersion: 2 });
    expect(pinned.status).toBe(200);
    const pinnedBody = await json<{ runId: string; workflowVersion: number; dryRun: boolean }>(
      pinned,
    );
    expect(pinnedBody).toMatchObject({ dryRun: true, note: null, workflowVersion: 2 });
    expect(await json(await get(`/runs/${pinnedBody.runId}`))).toMatchObject({
      run: { workflowVersion: 2, dryRun: true },
    });

    const withReal = await queue({ path: file, workflowVersion: 2 });
    expect(withReal.status).toBe(400);
    const unknown = await queue({ path: file, dryRun: true, workflowVersion: 99 });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ message: 'Workflow version not found' });

    // A blocked active version refuses a real run.
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 2')
      .run('{', wf);
    const blocked = await queue({ path: file });
    expect(blocked.status).toBe(422);
    expect(await json(blocked)).toMatchObject({ code: 'WORKFLOW_INVALID' });
    t.db
      .prepare(
        'UPDATE workflow_versions SET graph = (SELECT graph FROM workflow_versions WHERE workflow_id = ? AND version = 3) WHERE workflow_id = ? AND version = 2',
      )
      .run(wf, wf);

    // Nothing active: the real request for that workflow is queued as a dry run and says so.
    expect(t.deps.workflows.deactivate(wf).kind).toBe('ok');
    const none = await queue({ path: file, workflowId: wf });
    expect(none.status).toBe(200);
    expect(await json(none)).toMatchObject({
      dryRun: true,
      note: 'no active version',
      workflowVersion: 3,
    });
  });

  it('jobs.queue: a dry run of one file test-encodes by default, a folder does not; testEncode on a real run is 400; a plan token may test-encode; jobs.get and runs.get carry the flag', async () => {
    await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');

    const single = await queued({ path: file, dryRun: true });
    expect(single).toMatchObject({ testEncode: true });
    const off = await queued({ path: file, dryRun: true, testEncode: false });
    expect(off).toMatchObject({ testEncode: false });
    const folder = await queued({ path: root, dryRun: true });
    expect(folder).toMatchObject({ testEncode: false });
    const real = await queued({ path: file, force: true });
    expect(real).toMatchObject({ dryRun: false, testEncode: false });

    const refused = await queue({ path: file, dryRun: false, testEncode: true });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await json(refused))).toContain('only a dry run can test-encode');

    const plan = await createToken(t, s, { name: 'planner', scopes: ['plan'] });
    const planned = await queue({ path: file, dryRun: true, testEncode: true }, bearer(plan.token));
    expect(planned.status).toBe(200);
    expect(await json(planned)).toMatchObject({ testEncode: true });

    const jobId = single.jobIds[0] as string;
    expect(await json(await get(`/jobs/${jobId}`))).toMatchObject({ testEncode: true });
    expect(await json(await get(`/runs/${single.runId}`))).toMatchObject({
      run: { testEncode: true },
    });
    expect(await json(await get(`/runs/${folder.runId}`))).toMatchObject({
      run: { testEncode: false },
    });
    const listed = await json<{ jobs: { id: string; testEncode: boolean }[] }>(
      await get(`/jobs?runId=${off.runId}`),
    );
    expect(listed.jobs.map((j) => j.testEncode)).toEqual([false]);
  });

  it('jobs.get: testOutput and testOutputNote (null for a real job)', async () => {
    await fedLibrary();
    expect((await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) })).status).toBe(
      200,
    );
    const file = join(root, 'a.mkv');
    const test = (await queued({ path: file, dryRun: true })).jobIds[0] as string;
    const zero = (await queued({ path: file, dryRun: true })).jobIds[0] as string;
    const real = (await queued({ path: file, force: true })).jobIds[0] as string;
    const out = join(base, 'out.mkv');
    await writeFile(out, Buffer.alloc(321, 1));
    await t.deps.engine.testOutputs.keep(test, out, 'mkv');
    setSetting(t.db, 'engine.testEncodeKeepHours', 0, t.clock.now());
    await writeFile(out, Buffer.alloc(321, 1));
    await t.deps.engine.testOutputs.keep(zero, out, 'mkv');

    expect(await json(await get(`/jobs/${test}`))).toMatchObject({
      testOutput: {
        container: 'mkv',
        sizeBytes: 321,
        keptUntil: new Date(t.clock.now().getTime() + 2 * 3_600_000).toISOString(),
      },
      testOutputNote: null,
    });
    expect(await json(await get(`/jobs/${zero}`))).toMatchObject({
      testOutput: null,
      testOutputNote: 'not kept: test encodes are kept for 0 hours',
    });
    expect(await json(await get(`/jobs/${real}`))).toMatchObject({
      testOutput: null,
      testOutputNote: null,
    });
  });

  it('jobs.get returns trace, result, probe, the per-stream plan and the pinned graph after the fake run finishes; jobs.list rows carry libraryName, workflowName, reason, result sizes and replacedTo, plus per-state counts; jobs.stats sums saved bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { wf, id: libraryId } = await fedLibrary({ notify: true });
    // Every event of the run, to check none carries the webhook URL.
    const abort = new AbortController();
    const stream = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream', ...asSession(s, false) },
      signal: abort.signal,
    });
    const streamed = readEvents(stream, (ev) =>
      ev.some((e) => e.type === 'job.changed' && (e as { state?: string }).state === 'done'),
    );
    const { runId, jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;
    await until('encoding', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('final', () => isFinal(id));
    expect(row(id).state).toBe('done');
    const events = await streamed;
    abort.abort();
    expect(events.some((e) => e.type === 'job.trace')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const res = await get(`/jobs/${id}`);
    expect(res.status).toBe(200);
    const detail = await json<Record<string, unknown> & { graph: { nodes: { id: string }[] } }>(
      res,
    );
    expect(detail).toMatchObject({
      id,
      runId,
      state: 'done',
      fileName: 'a.mkv',
      libraryId,
      libraryName: 'TV',
      workflowId: wf,
      workflowVersion: 2,
      workflowName: 'Encode',
      reason: null,
      result: { outcome: 'done', beforeBytes: 1000, afterBytes: 600, replacedTo: 'recycle' },
      probe: { container: 'mkv', durationSeconds: 60 },
      plan: { rewrite: true, container: { from: 'mkv', to: 'mkv' } },
    });
    expect(detail).not.toHaveProperty('replaceJournal');
    expect(detail).not.toHaveProperty('fileId');
    expect(detail.probe).not.toHaveProperty('raw');
    expect((detail.plan as { streams: unknown[] }).streams).toHaveLength(2);
    expect(detail.graph.nodes.map((n) => n.id)).toEqual(['in', 'ev', 'ro', 'nw', 'render-1']);
    expect((detail.trace as { nodeId: string }[]).map((e) => e.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'ro',
      'nw',
    ]);
    expect((detail.path as { nodeId: string }[]).map((e) => e.nodeId)).toEqual([
      'in',
      'ev',
      'render-1',
      'ro',
      'nw',
    ]);
    // The webhook URL may carry a token: the job API never shows it.
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(JSON.stringify(detail)).toContain('https://hooks.example/…');

    const list = await json<{ jobs: Record<string, unknown>[]; counts: Record<string, number> }>(
      await get(`/jobs?libraryId=${libraryId}`),
    );
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({
      id,
      libraryName: 'TV',
      workflowName: 'Encode',
      reason: null,
      result: { outcome: 'done', beforeBytes: 1000, afterBytes: 600, replacedTo: 'recycle' },
    });
    expect(list.jobs[0]).not.toHaveProperty('trace');
    expect(list.counts).toMatchObject({ done: 1, queued: 0, failed: 0 });
    expect(Object.keys(list.counts)).toHaveLength(15);
    const filtered = await json<{ jobs: unknown[]; counts: Record<string, number> }>(
      await get('/jobs?state=queued&state=failed'),
    );
    expect(filtered.jobs).toEqual([]);
    const single = await json<{ jobs: { id: string }[] }>(await get('/jobs?state=done'));
    expect(single.jobs.map((j) => j.id)).toEqual([id]);
    expect(filtered.counts.done).toBe(1);
    const page = await json<{ jobs: unknown[] }>(await get(`/jobs?before=${id}&limit=10`));
    expect(page.jobs).toEqual([]);

    const stats = await get(`/jobs/stats?since=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    expect(await json(stats)).toEqual({
      files: 1,
      savedBytes: 400,
      failed: 0,
      queued: 0,
      running: 0,
      problems: 0,
    });
    expect((await get('/jobs/stats?since=yesterday')).status).toBe(400);

    expect(await json(await get(`/jobs/${id}/log`))).toEqual({ log: 'frame=1\n' });
    expect((await get('/jobs/nope')).status).toBe(404);
    expect((await get('/jobs/nope/log')).status).toBe(404);

    // Nor does any other jobs or runs answer.
    for (const path of [
      '/jobs',
      `/jobs?runId=${runId}`,
      `/jobs/${id}/log`,
      `/runs/${runId}`,
      '/runs',
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(SECRET);
    }
  });

  it('pause/resume/cancel need jobs:manage; cancel of a final job → 409 JOB_NOT_ACTIVE', async () => {
    await fedLibrary();
    await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
    const { jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;

    const read = await createToken(t, s, { name: 'ro', scopes: ['read', 'jobs:create'] });
    for (const action of ['pause', 'resume', 'cancel']) {
      expect(
        (await send(t, 'POST', `/jobs/${id}/${action}`, { headers: bearer(read.token) })).status,
      ).toBe(403);
    }
    const manage = await createToken(t, s, { name: 'ops', scopes: ['jobs:manage'] });
    const as = bearer(manage.token);
    expect((await send(t, 'POST', `/jobs/${id}/pause`, { headers: as })).status).toBe(200);
    expect(row(id).paused).toBe(true);
    expect((await send(t, 'POST', `/jobs/${id}/resume`, { headers: as })).status).toBe(200);
    expect(row(id).paused).toBe(false);
    const again = await send(t, 'POST', `/jobs/${id}/resume`, { headers: as });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'JOB_NOT_ACTIVE' });
    expect((await send(t, 'POST', `/jobs/${id}/cancel`, { headers: as })).status).toBe(200);
    expect(row(id).state).toBe('cancelled');

    const final = await send(t, 'POST', `/jobs/${id}/cancel`, { headers: as });
    expect(final.status).toBe(409);
    expect(await json(final)).toMatchObject({ code: 'JOB_NOT_ACTIVE' });
    expect((await send(t, 'POST', '/jobs/nope/cancel', { headers: as })).status).toBe(404);
  });
});

/** Reads server-sent events from a response until `enough` says stop (or 200 events). */
async function readEvents(
  res: Response,
  enough: (events: { type: string }[]) => boolean,
): Promise<Record<string, unknown>[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = '';
  while (events.length < 200 && !enough(events as { type: string }[])) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data !== '') events.push(JSON.parse(data) as Record<string, unknown>);
      end = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
}

describe('queue and events', () => {
  it('queue.pause persists and queue.status reports it; events stream yields queue.changed first, then job.changed with libraryId/workflowId, and a ping with heartbeatMs 10', async () => {
    const { wf, id: libraryId } = await fedLibrary();
    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    expect((await send(t, 'POST', '/queue/pause', { headers: bearer(read.token) })).status).toBe(
      403,
    );
    const paused = await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
    expect(paused.status).toBe(200);
    expect(await json(paused)).toEqual({
      paused: true,
      lanes: { encode: null, quick: null },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
      preparing: [],
    });
    expect(await json(await get('/queue', bearer(read.token)))).toMatchObject({ paused: true });
    expect(t.db.prepare("SELECT value FROM settings WHERE key = 'queue.paused'").get()).toEqual({
      value: 'true',
    });
    const { jobIds } = await queued({ path: join(root, 'a.mkv') });
    const id = jobIds[0] as string;

    const abort = new AbortController();
    const res = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream', ...bearer(read.token) },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reading = readEvents(
      res,
      (ev) => ev.some((e) => e.type === 'job.changed') && ev.some((e) => e.type === 'ping'),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(
      (await send(t, 'POST', `/jobs/${id}/pause`, { headers: asSession(s, true) })).status,
    ).toBe(200);
    const events = await reading;
    abort.abort();
    expect(events[0]).toEqual({
      type: 'queue.changed',
      paused: true,
      lanes: { encode: null, quick: null },
      encodeSlots: [{ id: 'encode', label: 'Encode', jobId: null }],
    });
    expect(events.find((e) => e.type === 'job.changed')).toMatchObject({
      jobId: id,
      libraryId,
      workflowId: wf,
      state: 'queued',
      paused: true,
      currentNode: null,
    });
    expect(events.find((e) => e.type === 'ping')).toMatchObject({ at: expect.any(String) });

    const resumed = await send(t, 'POST', '/queue/resume', { headers: asSession(s, true) });
    expect(await json(resumed)).toMatchObject({ paused: false });
  });

  it('closing the stream releases the engine subscription', async () => {
    const subscribe = vi.spyOn(t.deps.engine.events, 'subscribe');
    const abort = new AbortController();
    const res = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream', ...asSession(s, false) },
      signal: abort.signal,
    });
    await readEvents(res, (ev) => ev.length >= 2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const iterator = subscribe.mock.results[0]?.value as AsyncIterableIterator<unknown>;
    abort.abort();
    // A live subscription keeps yielding its 10 ms ping; a released one is done. The abort reaches
    // the generator's `finally` through several hops (stream cancel → oRPC return()), so poll.
    await vi.waitFor(
      async () => expect(await iterator.next()).toEqual({ done: true, value: undefined }),
      { timeout: UNTIL_MS, interval: 5 },
    );
  });

  it('events need read; an anonymous stream is 401', async () => {
    const res = await t.app.request('/api/v1/events', {
      headers: { host: 'localhost:8080', accept: 'text/event-stream' },
    });
    expect(res.status).toBe(401);
  });
});

describe('runs', () => {
  it('problems: jobs.list filters and counts jobs with problems whatever the state filter, jobs.get carries them, jobs.stats counts them', async () => {
    await fedLibrary();
    await writeFile(join(root, 'b.mkv'), Buffer.alloc(1000, 7));
    const a = (await queued({ path: join(root, 'a.mkv') })).jobIds[0] as string;
    await until('first encode', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('first final', () => isFinal(a));
    const b = (await queued({ path: join(root, 'b.mkv') })).jobIds[0] as string;
    await until('second encode', () => spawner.calls.length === 2);
    await finishEncode(600);
    await until('second final', () => isFinal(b));
    t.db
      .prepare('UPDATE job_results SET problems_json = ? WHERE job_id = ?')
      .run(JSON.stringify(['finished with a problem: room b did not answer']), b);

    const only = await json<{
      jobs: { id: string; problems: string[] }[];
      problemCount: number;
      counts: Record<string, number>;
    }>(await get('/jobs?problems=true'));
    expect(only.jobs.map((j) => j.id)).toEqual([b]);
    expect(only.jobs[0]?.problems).toEqual(['finished with a problem: room b did not answer']);
    expect(only.problemCount).toBe(1);
    expect(only.counts.done).toBe(2);
    const all = await json<{ jobs: { id: string; problems: string[] }[]; problemCount: number }>(
      await get('/jobs'),
    );
    expect(all.jobs).toHaveLength(2);
    expect(all.jobs.find((j) => j.id === a)?.problems).toEqual([]);
    // The state filter does not change the count.
    const queuedOnly = await json<{ jobs: unknown[]; problemCount: number }>(
      await get('/jobs?state=queued'),
    );
    expect(queuedOnly).toMatchObject({ jobs: [], problemCount: 1 });

    const detail = await json<{ problems: string[]; result: { problems: string[] } }>(
      await get(`/jobs/${b}`),
    );
    expect(detail.problems).toEqual(['finished with a problem: room b did not answer']);
    expect(detail.result.problems).toEqual(detail.problems);
    const stats = await json<{ problems: number; files: number }>(
      await get(`/jobs/stats?since=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`),
    );
    expect(stats).toMatchObject({ files: 2, problems: 1 });
  });

  it('runs.get counts reconcile: total === sum of outcome counts + in_progress; its jobs list carries result sizes', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    await fedLibrary();
    const { runId, jobIds } = await queued({ path: root });
    expect(jobIds).toHaveLength(2);
    await until('first encode', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('second encode', () => spawner.calls.length === 2);
    const second = jobIds.find((j) => row(j).state === 'encoding') as string;
    expect(
      (await send(t, 'POST', `/jobs/${second}/cancel`, { headers: asSession(s, true) })).status,
    ).toBe(200);
    await until('both final', () => jobIds.every(isFinal));

    const detail = await json<{
      run: { id: string; note: string | null };
      workflowName: string;
      libraryName: string;
      counts: Record<string, number>;
      files: Record<string, unknown>[];
    }>(await get(`/runs/${runId}`));
    expect(detail).toMatchObject({ run: { id: runId }, workflowName: 'Encode', libraryName: 'TV' });
    const { counts } = detail;
    const outcomes = [
      'done',
      'nothing_to_do',
      'kept_original',
      'failed',
      'cancelled',
      'dry_run',
      'skipped',
      'already_processed',
    ];
    expect(counts.total).toBe(2);
    expect(
      outcomes.reduce((n, k) => n + (counts[k] ?? 0), 0) +
        (counts.queued ?? 0) +
        (counts.in_progress ?? 0),
    ).toBe(counts.total);
    expect(counts).toMatchObject({ done: 1, cancelled: 1, queued: 0, in_progress: 0 });
    expect(detail.files).toHaveLength(2);
    expect(detail.run).toMatchObject({ note: null });
    expect(detail.files.map((f) => f.workflowVersion)).toEqual([2, 2]);
    // Both files prepare at once, so either may take the encode lane first.
    expect(detail.files.find((f) => f.state === 'done')).toMatchObject({
      fileName: expect.stringMatching(/^[ab]\.mkv$/),
      beforeBytes: 1000,
      afterBytes: 600,
      replacedTo: 'recycle',
    });

    const list = await json<{ runs: { run: { id: string } }[] }>(await get('/runs?limit=5'));
    expect(list.runs.map((r) => r.run.id)).toEqual([runId]);
    expect(list.runs[0]).not.toHaveProperty('files');
    expect((await get('/runs/nope')).status).toBe(404);
  });
});

describe('dry-run savings', () => {
  it('jobs.list, jobs.get and runs.get carry the estimate and a plan summary for dry runs only; no history means null, never a guess', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    await fedLibrary();
    const b = join(root, 'Show', 'b.mkv');

    // No finished real run yet: the plan is known, the size is not (plan-only dry runs).
    const first = await queued({ path: b, dryRun: true, testEncode: false });
    await until('first dry run', () => isFinal(first.jobIds[0] as string));
    const early = await json<{ jobs: Record<string, unknown>[] }>(
      await get(`/jobs?runId=${first.runId}`),
    );
    expect(early.jobs[0]).toMatchObject({
      dryRun: true,
      state: 'dry_run',
      estimatedBytes: null,
      planSummary: 'convert 1 video track',
    });

    // One real run that shrinks 1000 to 600 gives the workflow a ratio of 0.6.
    const real = await queued({ path: join(root, 'a.mkv') });
    await until('encoding', () => spawner.calls.length === 1);
    await finishEncode(600);
    await until('real final', () => isFinal(real.jobIds[0] as string));
    expect(row(real.jobIds[0] as string).state).toBe('done');

    const second = await queued({ path: b, dryRun: true, testEncode: false, force: true });
    const dryId = second.jobIds[0] as string;
    await until('second dry run', () => isFinal(dryId));
    const list = await json<{ jobs: Record<string, unknown>[] }>(await get('/jobs'));
    expect(list.jobs.find((j) => j.id === dryId)).toMatchObject({
      dryRun: true,
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
      result: { beforeBytes: 1000, afterBytes: null },
    });
    // The real job's row never claims an estimate.
    expect(list.jobs.find((j) => j.id === real.jobIds[0])).toMatchObject({
      dryRun: false,
      estimatedBytes: null,
      planSummary: null,
    });
    expect(await json(await get(`/jobs/${dryId}`))).toMatchObject({
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
    });

    const dryRun = await json<{ files: Record<string, unknown>[] }>(
      await get(`/runs/${second.runId}`),
    );
    expect(dryRun.files[0]).toMatchObject({
      state: 'dry_run',
      beforeBytes: 1000,
      afterBytes: null,
      estimatedBytes: 600,
      planSummary: 'convert 1 video track',
    });
    const realRun = await json<{ files: Record<string, unknown>[] }>(
      await get(`/runs/${real.runId}`),
    );
    expect(realRun.files[0]).toMatchObject({ estimatedBytes: null, planSummary: null });
  });
});

describe('system', () => {
  it('system.capabilities lists deviceProfiles with names', async () => {
    const res = await get('/system/capabilities');
    expect(res.status).toBe(200);
    const body = await json<{ deviceProfiles: { id: string; name: string }[] }>(res);
    expect(body).toMatchObject({ available: true, version: '9.0.2' });
    expect(body.deviceProfiles).toEqual([
      { id: 'android-tv', name: 'Android TV (Google TV / Shield class)' },
      { id: 'chrome', name: 'Chrome (desktop)' },
    ]);
  });
});

it('a job that failed before any result reads with result and plan null', async () => {
  await fedLibrary();
  await send(t, 'POST', '/queue/pause', { headers: asSession(s, true) });
  const { jobIds } = await queued({ path: join(root, 'a.mkv') });
  const id = jobIds[0] as string;
  updateJob(t.db, id, { state: 'failed', reason: 'boom' }, t.clock.now());
  const detail = await json(await get(`/jobs/${id}`));
  expect(detail).toMatchObject({ state: 'failed', reason: 'boom', result: null, plan: null });
});

describe('redactGraph', () => {
  it('shows webhook URLs in notify settings and Run-node overrides as scheme and host only', () => {
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('run', 'core:run-subworkflow', {
        subworkflowId: 'sub',
        version: 1,
        overrides: {
          'nw.url': `https://hooks.example/${SECRET}`,
          'nw.method': 'PUT',
          'other.endpoint': `http://10.0.0.5:8080/${SECRET}?k=${SECRET}`,
          'other.note': 'ftp-ish text, not a URL',
          'other.count': 3,
        },
      }),
      node('nw', 'core:notify-webhook', { url: `https://hooks.example/${SECRET}` }),
    );
    const out = redactGraph(graph);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.nodes[1]?.settings).toEqual({
      subworkflowId: 'sub',
      version: 1,
      overrides: {
        'nw.url': 'https://hooks.example/…',
        'nw.method': 'PUT',
        'other.endpoint': 'http://10.0.0.5:8080/…',
        'other.note': 'ftp-ish text, not a URL',
        'other.count': 3,
      },
    });
    expect(out.nodes[2]?.settings).toMatchObject({ url: 'https://hooks.example/…' });
    expect(out.edges).toEqual(graph.edges);
  });
});

describe('library feeds and upgrade notices', () => {
  it('namedByInactive lists the live workflows whose newest, not active version names the library, until one feeds it', async () => {
    const id = await library();
    await mkdir(join(base, 'movies'));
    const other = await createLibrary({ name: 'Other', path: join(base, 'movies') });
    const elsewhere = (await json(other)).id as string;
    /** A workflow whose version 2 (not activated) takes files from `libraryId`. */
    const naming = (name: string, libraryId: string) => {
      const { id: wf } = t.deps.workflows.create({ name, kind: 'workflow' }, 'u');
      const graph = chain(
        'workflow',
        node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      );
      t.deps.workflows.save({ id: wf, baseVersion: 1, graph }, 'u');
      return wf;
    };
    const cleanup = naming('Movie Cleanup', id);
    naming('Elsewhere', elsewhere);
    const gone = naming('Gone', id);
    expect(t.deps.workflows.delete(gone).kind).toBe('ok');
    const namedBy = async () => {
      const list = await json<{
        libraries: Array<{ id: string; namedByInactive: unknown }>;
      }>(await get('/libraries'));
      return list.libraries.find((l) => l.id === id)?.namedByInactive;
    };
    expect(await namedBy()).toEqual([{ workflowId: cleanup, name: 'Movie Cleanup', version: 2 }]);
    expect(await json(await get(`/libraries/${id}`))).toMatchObject({
      feeds: null,
      namedByInactive: [{ workflowId: cleanup, name: 'Movie Cleanup', version: 2 }],
    });
    expect(t.deps.workflows.activate(cleanup, 2, 'u').kind).toBe('ok');
    expect(await namedBy()).toEqual([]);
  });

  it("GET /libraries answers each library's feeder and the notices; dismissing needs jobs:manage", async () => {
    const { wf, id } = await fedLibrary();
    t.deps.workflows.rename(wf, 'Downsize');
    const list = async () =>
      json<{ libraries: Array<{ id: string; feeds: unknown }>; notices: string[] }>(
        await get('/libraries'),
      );
    expect(await list()).toMatchObject({
      libraries: [{ id, feeds: { workflowId: wf, name: 'Downsize', version: 2 } }],
      notices: [],
    });
    expect(await json(await get(`/libraries/${id}`))).toMatchObject({
      feeds: { workflowId: wf, name: 'Downsize', version: 2 },
    });
    t.deps.workflows.deactivate(wf);
    expect((await list()).libraries[0]?.feeds).toBeNull();

    const notice =
      'TV has no workflow now: its default, Encode, could not be switched to a Library input. Add one to Encode by hand.';
    setSetting(t.db, 'libraries.migrationNotices', [notice], new Date());
    expect((await list()).notices).toEqual([notice]);

    const read = await createToken(t, s, { name: 'ro', scopes: ['read'] });
    const dismiss = (headers: Record<string, string>) =>
      send(t, 'POST', '/libraries/notices/dismiss', { headers });
    expect((await dismiss(bearer(read.token))).status).toBe(403);
    expect((await list()).notices).toEqual([notice]);
    const ok = await dismiss(asSession(s, true));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await list()).notices).toEqual([]);
  });
});
