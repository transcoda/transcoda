import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSession, bearer, createToken, send } from '../../app/testing/http.ts';
import { setSetting } from '../../db/repos/settings.ts';
import { chain, node } from '../../workflows/test-helpers.ts';
import {
  base,
  createLibrary,
  fedLibrary,
  get,
  json,
  library,
  outside,
  queue,
  queued,
  root,
  s,
  spawner,
  t,
  until,
  useRpcApp,
} from './testing.ts';

useRpcApp();

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
    const got = await get(`/libraries/${id}`);
    expect(got.status).toBe(200);
    // The same clock the list carries: the server's time and zone, for run hours.
    expect(await json(got)).toMatchObject({
      id,
      clock: { now: t.clock.now().toISOString(), timeZone: expect.any(String) },
    });

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

  it('libraries.browse of a library whose folder is gone → 412 LIBRARY_UNREACHABLE; an unknown library stays 404', async () => {
    const id = await library();
    await rename(root, `${root}-unmounted`);
    try {
      const res = await get(`/libraries/${id}/browse`);
      expect(res.status).toBe(412);
      expect(await json(res)).toMatchObject({
        code: 'LIBRARY_UNREACHABLE',
        message: "The library folder can't be reached",
        data: { path: root },
      });
      expect((await get('/libraries/nope/browse')).status).toBe(404);
    } finally {
      await rename(`${root}-unmounted`, root);
    }
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
