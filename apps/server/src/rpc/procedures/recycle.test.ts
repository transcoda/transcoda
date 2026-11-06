import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJob, insertJobResult, insertRecycled } from '../../db/repos/jobs.ts';
import { insertLibrary } from '../../db/repos/libraries.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { insertWorkflow } from '../../db/repos/workflows.ts';
import { fingerprintKey, fingerprintOf } from '../../engine/fingerprint.ts';
import { tempDir } from '../../engine/fixtures.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, bearer, createToken, login, type Session, send } from '../../test-http.ts';

const recycledAt = '2026-01-01T00:00:00.000Z';
const jobId = 'j1';

let base: string;
let root: string;
let bin: string;
let t: TestApp;
let s: Session;

const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;
const get = (path: string) => send(t, 'GET', path, { headers: asSession(s, false) });
const restore = (headers: Record<string, string>, path = `${bin}/Show/a.mkv`) =>
  send(t, 'POST', '/recycle/restore', { body: { path }, headers });

beforeEach(async () => {
  base = await tempDir('rpc-recycle-');
  root = join(base, 'lib');
  bin = join(root, '.transcoda-recycle');
  await mkdir(join(root, 'Show'), { recursive: true });
  await mkdir(join(bin, 'Show'), { recursive: true });
  await writeFile(join(root, 'Show', 'a.mkv'), Buffer.alloc(300, 1));
  await writeFile(join(bin, 'Show', 'a.mkv'), Buffer.alloc(1000, 2));
  t = createTestApp({ config: { configDir: join(base, 'config') } });
  s = await login(t);
  const { db } = t;
  const now = new Date(recycledAt);
  insertWorkflow(
    db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    db,
    { id: 'l1', name: 'TV', path: root, recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: root,
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
  insertJob(
    db,
    {
      id: jobId,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: join(root, 'Show', 'a.mkv'),
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'done',
      priority: 0,
    },
    now,
  );
  insertJobResult(db, {
    jobId,
    fingerprint: fingerprintKey(await fingerprintOf(join(bin, 'Show', 'a.mkv'))),
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: 1000,
    afterBytes: 300,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    outputFingerprint: fingerprintKey(await fingerprintOf(join(root, 'Show', 'a.mkv'))),
    createdAt: recycledAt,
  });
  insertRecycled(db, {
    path: join(bin, 'Show', 'a.mkv'),
    libraryId: 'l1',
    jobId,
    sizeBytes: 1000,
    recycledAt,
    kind: 'original',
    originalPath: join(root, 'Show', 'a.mkv'),
  });
});

afterEach(async () => {
  await t.close();
  await rm(base, { recursive: true, force: true });
});

describe('recycle.restore', () => {
  it("recycle.restore (a person's session only): restores; any token is 403; a refusal is 409 with the reason", async () => {
    const all = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const token = await restore(bearer(all.token));
    expect(token.status).toBe(403);
    expect(await json(token)).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Restore is a UI action',
    });
    expect((await restore({})).status).toBe(401);
    expect((await restore(asSession(s, false))).status).toBe(403);

    const ok = await restore(asSession(s, true));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ jobId, direction: 'restored', notRestored: [] });
    expect((await restore(asSession(s, true))).status).toBe(404);

    // The original is back, so putting the output back over it now finds another file there.
    await writeFile(join(root, 'Show', 'a.mkv'), Buffer.alloc(1000, 3));
    const refused = await restore(asSession(s, true), `${bin}/Show/a.mkv.1`);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      code: 'RECYCLE_REFUSED',
      data: { reason: expect.stringMatching(/^This file changed after the restore/) },
    });
  });

  it('jobs.get shows where the original is kept and, after a restore, when and by whom', async () => {
    expect(await json(await get(`/jobs/${jobId}`))).toMatchObject({
      recycled: { path: `${bin}/Show/a.mkv`, keptUntil: '2026-01-08T00:00:00.000Z' },
      restore: null,
    });
    expect((await restore(asSession(s, true))).status).toBe(200);
    expect(await json(await get(`/jobs/${jobId}`))).toMatchObject({
      recycled: null,
      restore: {
        restoredAt: expect.any(String),
        restoredBy: 'admin',
        outputPath: `${bin}/Show/a.mkv.1`,
      },
    });
  });
});

describe('recycle.list, recycle.delete, recycle.empty', () => {
  async function secondLibrary(): Promise<string> {
    const films = join(base, 'films');
    await mkdir(join(films, '.transcoda-recycle'), { recursive: true });
    // Named to sort first, and empty: list still opens TV, the one with files.
    insertLibrary(
      t.db,
      { id: 'l0', name: 'A films', path: films, recycleFolder: null, processHardlinked: false },
      new Date(recycledAt),
    );
    return films;
  }

  it('recycle.list picks the first library with anything in its folder; a token with read may list', async () => {
    await secondLibrary();
    const reader = await createToken(t, s, { name: 'reader', scopes: ['read'] });
    const res = await send(t, 'GET', '/recycle', { headers: bearer(reader.token) });
    expect(res.status).toBe(200);
    const out = await json<{
      libraries: unknown[];
      library: { id: string; entries: unknown[] } | null;
    }>(res);
    expect(out.libraries).toEqual([
      { id: 'l0', name: 'A films', files: 0, bytes: 0 },
      { id: 'l1', name: 'TV', files: 1, bytes: 1000 },
    ]);
    expect(out.library).toMatchObject({
      id: 'l1',
      name: 'TV',
      folder: bin,
      totalBytes: 1000,
      retentionDays: 7,
      entries: [
        {
          path: `${bin}/Show/a.mkv`,
          relativePath: 'Show/a.mkv',
          kind: 'original',
          sizeBytes: 1000,
          jobId,
          recycledAt,
          deletesAt: '2026-01-08T00:00:00.000Z',
        },
      ],
    });
    const l0 = await json<{ library: { id: string; entries: unknown[] } }>(
      await get('/recycle?libraryId=l0'),
    );
    expect(l0.library).toMatchObject({ id: 'l0', entries: [] });
    expect((await get('/recycle?libraryId=nope')).status).toBe(404);
  });

  it("recycle.delete and recycle.empty (a person's session only): any token is 403 with the UI-action message", async () => {
    const all = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const del = (headers: Record<string, string>, path = `${bin}/Show/a.mkv`) =>
      send(t, 'POST', '/recycle/delete', { body: { path }, headers });
    const empty = (headers: Record<string, string>, libraryId = 'l1') =>
      send(t, 'POST', '/recycle/empty', {
        body: { libraryId, throughRecycledAt: '2026-01-02T00:00:00.000Z' },
        headers,
      });
    for (const [call, message] of [
      [del, 'Deleting from the recycle folder is a UI action'],
      [empty, 'Deleting from the recycle folder is a UI action'],
    ] as const) {
      const res = await call(bearer(all.token));
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'FORBIDDEN', message });
      expect((await call({})).status).toBe(401);
      expect((await call(asSession(s, false))).status).toBe(403);
    }
    const ok = await del(asSession(s, true));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ bytes: 1000 });
    expect((await del(asSession(s, true))).status).toBe(404);
    expect((await empty(asSession(s, true), 'nope')).status).toBe(404);
  });

  it('recycle.empty only removes what was confirmed', async () => {
    await writeFile(join(bin, 'Show', 'b.mkv'), Buffer.alloc(10));
    insertRecycled(t.db, {
      path: join(bin, 'Show', 'b.mkv'),
      libraryId: 'l1',
      jobId,
      sizeBytes: 10,
      recycledAt: '2026-01-03T00:00:00.000Z',
      kind: 'original',
      originalPath: join(root, 'Show', 'b.mkv'),
    });
    const res = await send(t, 'POST', '/recycle/empty', {
      body: { libraryId: 'l1', throughRecycledAt: '2026-01-02T00:00:00.000Z' },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ removed: 1, bytes: 1000, skipped: 0 });
    const out = await json<{ library: { entries: { path: string }[] } }>(await get('/recycle'));
    expect(out.library.entries.map((e) => e.path)).toEqual([join(bin, 'Show', 'b.mkv')]);
  });
});
