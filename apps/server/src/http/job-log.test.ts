import fs from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertJob } from '../db/repos/jobs.ts';
import { insertLibrary } from '../db/repos/libraries.ts';
import { insertRun } from '../db/repos/runs.ts';
import { insertWorkflow } from '../db/repos/workflows.ts';
import { tempDir } from '../engine/fixtures.ts';
import { logPathFor } from '../engine/pipeline.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, bearer, createToken, HOST, login, type Session, send } from '../test-http.ts';

const LOG = 'ffmpeg version 7\nset_mempolicy: Operation not permitted\nframe=100\n';

let base: string;
let t: TestApp;
let s: Session;

const url = (id: string) => `/jobs/${id}/log/download`;

/** A running job ('queued' is not final: its log is its current attempt's). */
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
      dryRun: false,
      testEncode: false,
      state: 'queued',
      priority: 0,
    },
    t.clock.now(),
  );
}

async function writeLog(id: string, text: string): Promise<string> {
  const path = logPathFor(t.deps.config, { id, attempt: 1 });
  await mkdir(join(base, 'config', 'logs', 'jobs'), { recursive: true });
  await writeFile(path, text);
  return path;
}

beforeEach(async () => {
  base = await tempDir('job-log-route-');
  t = createTestApp({ config: { configDir: join(base, 'config') } });
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
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    t.clock.now(),
  );
  job('a', 'Show: "Pilot" <1>.mkv');
  job('b', 'b.mkv');
  job('c', 'c.mkv');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await rm(base, { recursive: true, force: true });
});

describe('GET /jobs/{id}/log/download', () => {
  it('a session downloads the whole log as a private text attachment', async () => {
    await writeLog('a', LOG);
    const res = await send(t, 'GET', url('a'), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="Show_ _Pilot_ _1_.ffmpeg.log"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(LOG)));
    expect(await res.text()).toBe(LOG);
  });

  it('an empty log is an empty file', async () => {
    await writeLog('b', '');
    const res = await send(t, 'GET', url('b'), { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('no log yet, an unknown job and a symlinked log → 404', async () => {
    const target = join(base, 'secret.txt');
    await writeFile(target, 'secret');
    await mkdir(join(base, 'config', 'logs', 'jobs'), { recursive: true });
    await symlink(target, logPathFor(t.deps.config, { id: 'c', attempt: 1 }));
    for (const id of ['b', 'missing', 'c']) {
      const res = await send(t, 'GET', url(id), { headers: asSession(s, false) });
      expect(res.status, id).toBe(404);
      expect(await res.text()).not.toContain('secret');
    }
  });

  it('a token → 403, no session → 401, cross-site → 403', async () => {
    await writeLog('a', LOG);
    const { token } = await createToken(t, s);
    const byToken = await send(t, 'GET', url('a'), { headers: bearer(token) });
    expect(byToken.status).toBe(403);
    expect(await byToken.text()).not.toContain('frame=100');
    expect((await send(t, 'GET', url('a'))).status).toBe(401);
    const cross = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.status).toBe(403);
  });

  it('a client that goes away mid-download destroys the file stream (and closes its fd)', async () => {
    await writeLog('a', LOG);
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

  it('a request already aborted never leaves a stream open; Range is honoured', async () => {
    await writeLog('a', LOG);
    const stream = vi.spyOn(fs, 'createReadStream');
    const abort = new AbortController();
    abort.abort();
    await Promise.resolve(
      t.app.request(`/api/v1${url('a')}`, {
        headers: { host: HOST, ...asSession(s, false) },
        signal: abort.signal,
      }),
    ).catch(() => null);
    // Whatever stream the response opened was destroyed at once.
    for (const r of stream.mock.results) expect((r.value as fs.ReadStream).destroyed).toBe(true);
    const part = await send(t, 'GET', url('a'), {
      headers: { ...asSession(s, false), range: 'bytes=0-5' },
    });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('ffmpeg');
  });
});
