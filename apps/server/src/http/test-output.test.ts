import childProcess, { execFile } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, mkdir, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertJob, insertJobResult } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { fixturePath, fixturesAvailable, tempDir, toolPaths } from '../engine/fixtures.ts';
import { type FsOps, nodeFsOps } from '../engine/fs-ops.ts';
import { buildPreview } from '../engine/preview.ts';
import { scratchMinFreeBytes, TEST_OUTPUT_DIR } from '../engine/test-outputs.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, HOST, login, type Session, send } from '../test-http.ts';

vi.mock('../engine/preview.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/preview.ts')>();
  return { ...real, buildPreview: vi.fn(real.buildPreview) };
});

vi.setConfig({ testTimeout: 30_000 });

const run = promisify(execFile);
const BYTES = Buffer.from('0123456789abcdefghij');
const build = vi.mocked(buildPreview);
/** What the stubbed ffmpeg writes as the preview. */
const PREVIEW = Buffer.from('ftyp-preview-mp4-bytes-0123456789');

/** Stubs ffmpeg: writes PREVIEW to the .part, after `gate` resolves when given. */
function fakeBuild(gate?: Promise<void>): void {
  build.mockImplementation(async ({ input, outPath }) => {
    await gate;
    input.destroy();
    await writeFile(outPath, PREVIEW);
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let base: string;
let tc: string;
let t: TestApp;
let s: Session;

/** Free bytes the fake statfs reports. */
let free: number;
const fsOps: FsOps = {
  ...nodeFsOps,
  statfs: async () => ({ bavail: free, bsize: 1 }),
};

const url = (id: string, play = false) => `/jobs/${id}/test-output${play ? '?play=1' : ''}`;

function job(id: string, file: string): void {
  insertJob(
    t.db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: join(base, 'lib', file),
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: true,
      testEncode: true,
      state: 'dry_run',
      priority: 0,
    },
    t.clock.now(),
  );
}

/** Keeps `bytes` (or a copy of `from`) as the job's test output, the way the pipeline does. */
async function keep(
  id: string,
  container: 'mkv' | 'mp4',
  bytes: Buffer | { from: string } = BYTES,
): Promise<string> {
  const p = join(tc, id, `out.${container}`);
  await mkdir(join(tc, id), { recursive: true });
  if (Buffer.isBuffer(bytes)) await writeFile(p, bytes);
  else await copyFile(bytes.from, p);
  const row = await t.deps.engine.testOutputs.keep(id, p, container);
  expect(row).not.toBeNull();
  return join(tc, TEST_OUTPUT_DIR, `${id}.${container}`);
}

beforeEach(async () => {
  free = 1024 ** 4;
  base = await tempDir('test-output-route-');
  tc = join(base, 'transcode');
  await mkdir(tc, { recursive: true });
  await mkdir(join(base, 'lib'), { recursive: true });
  t = createTestApp({
    config: { transcodeDir: tc, ffmpegPath: toolPaths().ffmpegPath },
    fsOps,
  });
  s = await login(t);
  insertWorkflow(
    t.db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    t.clock.now(),
  );
  insertLibrary(
    t.db,
    {
      id: 'l1',
      name: 'TV',
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
      dryRun: true,
      testEncode: true,
      force: false,
      createdBy: 'u',
    },
    t.clock.now(),
  );
  job('a', 'a.mkv');
  job('m', 'Show: "Pilot" <1>.mp4');
  job('n', 'nothing.mkv');
  job('b', 'b.mkv');
  job('c', 'c.mkv');
});

afterEach(async () => {
  vi.restoreAllMocks();
  build.mockReset();
  await t.close();
  await rm(base, { recursive: true, force: true });
});

describe('GET /jobs/{id}/test-output', () => {
  it('a session downloads the kept file as a private attachment', async () => {
    await keep('a', 'mkv');
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/x-matroska');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a.test-encode.mkv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(BYTES.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('the download name keeps only safe characters', async () => {
    await keep('m', 'mp4');
    const res = await send(t, 'GET', url('m'), { headers: asSession(s, false) });
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Show_ _Pilot_ _1_.test-encode.mp4"',
    );
    await res.arrayBuffer();
  });

  it('answers one Range with 206 and an unsatisfiable one with 416', async () => {
    await keep('a', 'mkv');
    const part = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), range: 'bytes=2-5' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 2-5/${BYTES.length}`);
    expect(part.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(BYTES.subarray(2, 6));

    const close = vi.spyOn(fs, 'closeSync');
    const past = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), range: 'bytes=999999-' },
    });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${BYTES.length}`);
    expect(close).toHaveBeenCalledOnce();
  });

  it('HEAD answers the headers and leaves no file open, however often', async () => {
    const kept = await keep('a', 'mkv');
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    const stream = vi.spyOn(fs, 'createReadStream');
    const spawn = vi.spyOn(childProcess, 'spawn');
    for (const play of [false, false, false, true, true]) {
      const res = await t.app.request(`/api/v1${url('a', play)}`, {
        method: 'HEAD',
        headers: { host: HOST, ...asSession(s, false) },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(play ? 'video/mp4' : 'video/x-matroska');
    }
    const fds = open.mock.results
      .filter((r, i) => r.type === 'return' && open.mock.calls[i]?.[0] === kept)
      .map((r) => r.value as number);
    expect(fds).toHaveLength(5);
    const closed = new Set(close.mock.calls.map((c) => c[0]));
    for (const fd of fds) expect(closed.has(fd)).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(fs.existsSync(join(tc, TEST_OUTPUT_DIR, 'a.preview.mp4'))).toBe(false);
  });

  it('GET streams from the fd it checked (no second open by path)', async () => {
    await keep('a', 'mkv');
    const stream = vi.spyOn(fs, 'createReadStream');
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0]).toBe('');
    expect(stream.mock.calls[0]?.[1]).toMatchObject({ autoClose: true, fd: expect.any(Number) });
  });

  it('a token with every scope → 403 and no bytes', async () => {
    await keep('a', 'mkv');
    const { token } = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const res = await send(t, 'GET', url('a'), { headers: bearer(token) });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('Test outputs are played in the UI');
    expect(body).not.toContain('0123456789');
  });

  it('no session → 401', async () => {
    await keep('a', 'mkv');
    expect((await send(t, 'GET', url('a'))).status).toBe(401);
  });

  it('a cross-site request → 403 CSRF_FAILED even with the session cookie', async () => {
    await keep('a', 'mkv');
    const res = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('CSRF_FAILED');
  });

  it('an unknown id, a job without a kept output and traversal → 404', async () => {
    await keep('a', 'mkv');
    for (const id of ['missing', 'n', '..%2F..%2Fetc', '..%2Ftest-outputs%2Fa.mkv', 'a.mkv']) {
      const res = await send(t, 'GET', url(id), { headers: asSession(s, false) });
      expect(res.status, id).toBe(404);
      expect(await res.text(), id).not.toContain('0123456789');
    }
  });

  it('a symlink swapped in at the kept path → 404', async () => {
    const kept = await keep('a', 'mkv');
    const secret = join(base, 'secret.txt');
    await writeFile(secret, 'do not serve');
    await unlink(kept);
    await symlink(secret, kept);
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('do not serve');
  });

  it('?play=1 on an mp4 output is served inline, with Range', async () => {
    await keep('m', 'mp4');
    const res = await send(t, 'GET', url('m', true), {
      headers: { ...asSession(s, false), range: 'bytes=0-3' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toBe(
      'inline; filename="Show_ _Pilot_ _1_.test-encode.mp4"',
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES.subarray(0, 4));
    expect(build).not.toHaveBeenCalled();
  });

  it.skipIf(!fixturesAvailable())(
    '?play=1 on an mkv output is a seekable mp4 with a finite duration (real ffmpeg)',
    async () => {
      await keep('a', 'mkv', { from: fixturePath('two-defaults-h264.mkv') });
      const part = await send(t, 'GET', url('a', true), {
        headers: { ...asSession(s, false), range: 'bytes=0-10' },
      });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-type')).toBe('video/mp4');
      expect(part.headers.get('accept-ranges')).toBe('bytes');
      expect(part.headers.get('content-range')).toMatch(/^bytes 0-10\/\d+$/);
      const body = Buffer.from(await part.arrayBuffer());
      expect(body.subarray(4, 8).toString('latin1')).toBe('ftyp');

      const res = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
      expect(res.status).toBe(200);
      const out = join(base, 'played.mp4');
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      const { stdout } = await run(toolPaths().ffprobePath, [
        ...['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name'],
        ...['-of', 'json', out],
      ]);
      const probe = JSON.parse(stdout) as {
        format: { format_name: string; duration: string };
        streams: { codec_name: string }[];
      };
      expect(probe.format.format_name).toMatch(/^mov,mp4/);
      expect(Number.isFinite(Number(probe.format.duration))).toBe(true);
      // No stored plan: the audio codec is unknown, so the preview is the video alone.
      expect(probe.streams.map((x) => x.codec_name)).toEqual(['h264']);
      expect(build).toHaveBeenCalledOnce();
    },
  );

  it('?play=1 on an mkv builds the preview once and serves it with Range', async () => {
    await keep('a', 'mkv');
    fakeBuild();
    const part = await send(t, 'GET', url('a', true), {
      headers: { ...asSession(s, false), range: 'bytes=2-5' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('content-disposition')).toBe('inline; filename="a.test-encode.mp4"');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-range')).toBe(`bytes 2-5/${PREVIEW.length}`);
    expect(part.headers.get('cache-control')).toBe('no-store');
    expect(part.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(PREVIEW.subarray(2, 6));

    const whole = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(PREVIEW.length));
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(PREVIEW);

    const past = await send(t, 'GET', url('a', true), {
      headers: { ...asSession(s, false), range: 'bytes=9999-' },
    });
    expect(past.status).toBe(416);
    expect(build).toHaveBeenCalledOnce();
    expect((await readdir(join(tc, TEST_OUTPUT_DIR))).sort()).toEqual(['a.mkv', 'a.preview.mp4']);

    // HEAD with the preview built gives its length, and still builds nothing.
    const head = await t.app.request(`/api/v1${url('a', true)}`, {
      method: 'HEAD',
      headers: { host: HOST, ...asSession(s, false) },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(PREVIEW.length));
    expect(build).toHaveBeenCalledOnce();
  });

  it("the build gets the job's stored plan", async () => {
    await keep('a', 'mkv');
    const plan = {
      container: { from: 'mkv', to: 'mkv' },
      streams: [],
      rewrite: true,
      output: [
        { type: 'video' as const, codec: 'hevc' },
        { type: 'audio' as const, codec: 'eac3' },
      ],
    };
    insertJobResult(t.db, {
      jobId: 'a',
      fingerprint: 'fp',
      workflowId: 'w1',
      workflowVersion: 1,
      outcome: 'dry_run',
      beforeBytes: 100,
      afterBytes: 60,
      estimatedBytes: null,
      command: null,
      plan,
      replacedTo: null,
      logPath: null,
      warnings: [],
      problems: [],
      outputProbe: null,
      createdAt: t.clock.now().toISOString(),
    });
    fakeBuild();
    const res = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ plan, ffmpegPath: toolPaths().ffmpegPath }),
    );
  });

  it('plays of one job at once share one build', async () => {
    await keep('a', 'mkv');
    const gate = deferred();
    fakeBuild(gate.promise);
    const first = send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    const second = send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    gate.resolve();
    for (const res of await Promise.all([first, second])) {
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PREVIEW);
    }
    expect(build).toHaveBeenCalledOnce();
  });

  it('a third build at once is BUSY; the slots free up when the builds end', async () => {
    for (const id of ['a', 'b', 'c']) await keep(id, 'mkv');
    const gate = deferred();
    fakeBuild(gate.promise);
    const first = send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    const second = send(t, 'GET', url('b', true), { headers: asSession(s, false) });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    const close = vi.spyOn(fs, 'closeSync');
    const third = await send(t, 'GET', url('c', true), { headers: asSession(s, false) });
    expect(third.status).toBe(503);
    expect(third.headers.get('retry-after')).toBe('5');
    expect(await third.json()).toMatchObject({ code: 'BUSY' });
    expect(close).toHaveBeenCalledOnce();
    gate.resolve();
    for (const res of await Promise.all([first, second])) {
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const again = await send(t, 'GET', url('c', true), { headers: asSession(s, false) });
    expect(again.status).toBe(200);
    await again.arrayBuffer();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('too little scratch space for a preview → 503 SCRATCH_LOW, nothing built', async () => {
    await keep('a', 'mkv');
    fakeBuild();
    free = scratchMinFreeBytes(t.deps.config) + BYTES.length - 1;
    const res = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      code: 'SCRATCH_LOW',
      message: 'Not enough scratch space to prepare the preview',
    });
    expect(build).not.toHaveBeenCalled();
    expect(await readdir(join(tc, TEST_OUTPUT_DIR))).toEqual(['a.mkv']);

    free = scratchMinFreeBytes(t.deps.config) + BYTES.length;
    const ok = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  it('a failed build → 500, logged at warn, nothing left behind; the next play tries again', async () => {
    await keep('a', 'mkv');
    const warn = vi.spyOn(t.deps.log, 'warn');
    build.mockImplementationOnce(async ({ input, outPath }) => {
      input.destroy();
      await writeFile(outPath, 'half');
      throw new Error('Invalid data found when processing input\nmore');
    });
    const res = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_FAILED' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'test output preview failed',
        job: 'a',
        error: 'Invalid data found when processing input',
      }),
    );
    expect(await readdir(join(tc, TEST_OUTPUT_DIR))).toEqual(['a.mkv']);

    fakeBuild();
    const again = await send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    expect(again.status).toBe(200);
    await again.arrayBuffer();
  });

  it('HEAD ?play=1 says in x-preview whether a play now would be served or refused', async () => {
    for (const id of ['a', 'b', 'c']) await keep(id, 'mkv');
    const state = async (id: string) =>
      (
        await t.app.request(`/api/v1${url(id, true)}`, {
          method: 'HEAD',
          headers: { host: HOST, ...asSession(s, false) },
        })
      ).headers.get('x-preview');
    expect(await state('a')).toBe('none');
    free = scratchMinFreeBytes(t.deps.config) + BYTES.length - 1;
    expect(await state('a')).toBe('scratchLow');
    free = 1024 ** 4;
    const gate = deferred();
    fakeBuild(gate.promise);
    const first = send(t, 'GET', url('a', true), { headers: asSession(s, false) });
    const second = send(t, 'GET', url('b', true), { headers: asSession(s, false) });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(await state('a')).toBe('building');
    expect(await state('c')).toBe('busy');
    gate.resolve();
    for (const res of await Promise.all([first, second])) await res.arrayBuffer();
    expect(await state('a')).toBe('ready');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a client gone while the preview was built: no body, the preview fd is closed', async () => {
    await keep('a', 'mkv');
    const gate = deferred();
    fakeBuild(gate.promise);
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    const stream = vi.spyOn(fs, 'createReadStream');
    const abort = new AbortController();
    const pending = t.app.request(`/api/v1${url('a', true)}`, {
      headers: { host: HOST, ...asSession(s, false) },
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce());
    abort.abort();
    gate.resolve();
    const res = await pending;
    expect(res.body).toBeNull();
    const preview = join(tc, TEST_OUTPUT_DIR, 'a.preview.mp4');
    const fds = open.mock.results
      .filter((r, i) => r.type === 'return' && open.mock.calls[i]?.[0] === preview)
      .map((r) => r.value as number);
    expect(fds).toHaveLength(1);
    expect(close.mock.calls.map((c) => c[0])).toContain(fds[0]);
    // Only the build read a stream (the kept output); none was opened on the preview.
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('a client that goes away mid-download destroys the file stream (and closes its fd)', async () => {
    await keep('a', 'mkv');
    const stream = vi.spyOn(fs, 'createReadStream');
    const abort = new AbortController();
    const res = await t.app.request(`/api/v1${url('a')}`, {
      headers: { host: HOST, ...asSession(s, false) },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    const file = stream.mock.results[0]?.value as fs.ReadStream;
    expect(file.destroyed).toBe(false);
    abort.abort();
    expect(file.destroyed).toBe(true);
    await vi.waitFor(() => expect(file.closed).toBe(true));
  });

  it('deleting the output deletes its preview', async () => {
    await keep('a', 'mkv');
    fakeBuild();
    await (await send(t, 'GET', url('a', true), { headers: asSession(s, false) })).arrayBuffer();
    expect(fs.existsSync(join(tc, TEST_OUTPUT_DIR, 'a.preview.mp4'))).toBe(true);
    const res = await send(t, 'DELETE', url('a'), { headers: asSession(s, true) });
    expect(res.status).toBe(200);
    expect(await readdir(join(tc, TEST_OUTPUT_DIR))).toEqual([]);
  });
});

describe('DELETE /jobs/{id}/test-output', () => {
  it('a session deletes the kept output; again → 404', async () => {
    const kept = await keep('a', 'mkv');
    const res = await send(t, 'DELETE', url('a'), { headers: asSession(s, true) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fs.existsSync(kept)).toBe(false);
    expect(t.deps.engine.jobDetail('a')?.testOutputNote).toBe('deleted');
    expect(t.deps.engine.jobDetail('a')?.testOutput).toBeNull();
    const again = await send(t, 'DELETE', url('a'), { headers: asSession(s, true) });
    expect(again.status).toBe(404);
  });

  it('a token → 403, the output stays', async () => {
    const kept = await keep('a', 'mkv');
    const { token } = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const res = await send(t, 'DELETE', url('a'), { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Test outputs are handled in the UI');
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('a session without the CSRF token → 403, the output stays', async () => {
    const kept = await keep('a', 'mkv');
    const res = await send(t, 'DELETE', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(403);
    expect(fs.existsSync(kept)).toBe(true);
  });
});
