import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../auth/cookies.ts';
import { insertLibrary } from '../../db/repos/libraries.ts';
import type { Logger } from '../../logger.ts';
import { createTestApp, type TestApp, type TestAppOptions } from '../../test-app.ts';
import {
  asSession,
  bearer,
  createToken,
  HOST,
  login,
  ORIGIN,
  type Session,
  send,
} from '../../test-http.ts';
import {
  bumpV1,
  bumpV2,
  chain,
  childGraph,
  node,
  testRegistry,
} from '../../workflows/test-helpers.ts';

const nodes = testRegistry(bumpV1()).list();

function app(opts: TestAppOptions = {}): TestApp {
  return createTestApp({ nodes, ...opts });
}

/** in → <middle> → replace-original */
function mainWith(...middle: NodeInstance[]): WorkflowGraph {
  return chain(
    'workflow',
    node('in', 'core:input-manual'),
    ...middle,
    node('ro', 'core:replace-original'),
  );
}

function run(id: string, subworkflowId: string, version: number): NodeInstance {
  const settings: JsonValue = { subworkflowId, version, overrides: {} };
  return node(id, 'core:run-subworkflow', settings);
}

interface Detail {
  id: string;
  name: string;
  kind: string;
  active: { version: number; runnable: boolean; activatedBy: string } | null;
  version: number;
  currentVersion: number;
  valid: boolean;
  issues: Array<{ code: string; severity: string }>;
  graph: WorkflowGraph;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function create(
  t: TestApp,
  s: Session,
  name: string,
  kind: 'workflow' | 'subworkflow' = 'workflow',
): Promise<Detail> {
  const res = await send(t, 'POST', '/workflows', {
    body: { name, kind },
    headers: asSession(s, true),
  });
  expect(res.status).toBe(200);
  return json<Detail>(res);
}

function save(t: TestApp, s: Session, id: string, baseVersion: number, graph: unknown) {
  return send(t, 'PUT', `/workflows/${id}`, {
    body: { baseVersion, graph },
    headers: asSession(s, true),
  });
}

const codes = (issues: Array<{ code: string; severity: string }>) =>
  issues.map((i) => `${i.severity}:${i.code}`);

describe('nodes procedures', () => {
  it('nodes.list needs read; returns core nodes with JSON Schema settings, source and availability', async () => {
    const t = app();
    expect((await send(t, 'GET', '/nodes')).status).toBe(401);
    const s = await login(t);
    const res = await send(t, 'GET', '/nodes', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const body = await json<{ nodes: Array<Record<string, unknown>> }>(res);
    const keep = body.nodes.find((n) => n.type === 'core:keep-languages');
    expect(keep).toMatchObject({
      settingsSchema: { properties: { languages: { default: ['en'] } } },
      source: { kind: 'core' },
    });
    expect(body.nodes.some((n) => n.type === 'test:bump')).toBe(true);

    const { token: readToken } = await createToken(t, s);
    expect((await send(t, 'GET', '/nodes', { headers: bearer(readToken) })).status).toBe(200);
    const { token: planToken } = await createToken(t, s, { name: 'p', scopes: ['plan'] });
    expect((await send(t, 'GET', '/nodes', { headers: bearer(planToken) })).status).toBe(403);
  });

  it('nodes.list while ffmpeg is unavailable: ffmpeg-dependent nodes unavailable, others available', async () => {
    const t = app({ capabilities: { available: false, path: 'ffmpeg', error: 'x' } });
    const s = await login(t);
    const res = await send(t, 'GET', '/nodes', { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    const list = (await json<{ nodes: Array<{ type: string; availability: unknown }> }>(res)).nodes;
    const availability = (type: string) => list.find((n) => n.type === type)?.availability;
    expect(availability('core:encode-audio')).toEqual({
      available: false,
      reason: 'ffmpeg is not available',
    });
    expect(availability('core:keep-languages')).toEqual({ available: true });
  });
});

describe('workflows procedures', () => {
  it('create/get/list/versions round trip (session); list body is { workflows: [...] }', async () => {
    const t = app();
    const s = await login(t);
    const me = await json<{ user: { id: string } }>(
      await send(t, 'GET', '/auth/me', { headers: asSession(s, false) }),
    );
    const created = await create(t, s, 'Main');
    expect(created).toMatchObject({
      name: 'Main',
      kind: 'workflow',
      active: null,
      version: 1,
      currentVersion: 1,
    });
    expect((await save(t, s, created.id, 1, mainWith(node('b', 'test:bump')))).status).toBe(200);

    const got = await send(t, 'GET', `/workflows/${created.id}`, { headers: asSession(s, false) });
    expect(got.status).toBe(200);
    expect(await json<Detail>(got)).toMatchObject({ version: 2, currentVersion: 2, valid: true });
    const v1 = await send(t, 'GET', `/workflows/${created.id}?version=1`, {
      headers: asSession(s, false),
    });
    expect(v1.status).toBe(200);
    expect(await json<Detail>(v1)).toMatchObject({ version: 1, currentVersion: 2 });

    const list = await send(t, 'GET', '/workflows', { headers: asSession(s, false) });
    expect(list.status).toBe(200);
    const listBody = await json<{ workflows: Array<{ id: string; name: string }> }>(list);
    expect(listBody.workflows.map((w) => [w.id, w.name])).toEqual([[created.id, 'Main']]);

    const versions = await send(t, 'GET', `/workflows/${created.id}/versions`, {
      headers: asSession(s, false),
    });
    expect(versions.status).toBe(200);
    const vBody = await json<{ versions: Array<{ version: number; createdBy: string }> }>(versions);
    expect(vBody.versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(vBody.versions.every((v) => v.createdBy === me.user.id)).toBe(true);

    for (const path of [
      '/workflows/nope',
      `/workflows/${created.id}?version=9`,
      '/workflows/nope/versions',
    ]) {
      const res = await send(t, 'GET', path, { headers: asSession(s, false) });
      expect(res.status).toBe(404);
      expect((await json<{ code: string }>(res)).code).toBe('NOT_FOUND');
    }
  });

  it('POST /workflows with a graph of the wrong kind → 400 KIND_MISMATCH; with a redacted URL → 400 HIDDEN_URL_UNKNOWN with the node id', async () => {
    const t = app();
    const s = await login(t);
    const post = (graph: unknown) =>
      send(t, 'POST', '/workflows', {
        body: { name: 'N', kind: 'workflow', graph },
        headers: asSession(s, true),
      });
    const mismatch = await post(childGraph());
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: 'KIND_MISMATCH', defined: true });
    const hidden = await post(
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('n', 'core:notify-webhook', { url: 'https://h/…', method: 'POST' }),
      ),
    );
    expect(hidden.status).toBe(400);
    expect(await hidden.json()).toMatchObject({
      code: 'HIDDEN_URL_UNKNOWN',
      defined: true,
      data: { nodeIds: ['n'] },
    });
    expect(t.deps.workflows.list()).toEqual([]);
  });

  it('POST /workflows with a graph stores it with the note and echoes it redacted', async () => {
    const t = app();
    const s = await login(t);
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('n', 'core:notify-webhook', {
        url: 'https://hooks.example/s3cret?k=s3cret',
        method: 'POST',
      }),
    );
    const res = await send(t, 'POST', '/workflows', {
      body: { name: 'N', kind: 'workflow', graph, note: 'first' },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('s3cret');
    const body = JSON.parse(text) as Detail;
    expect(body.graph.nodes.find((n) => n.id === 'n')?.settings).toEqual({
      url: 'https://hooks.example/…',
      method: 'POST',
    });
    const stored = t.deps.workflows.get(body.id);
    expect(JSON.stringify(stored?.graph)).toContain('s3cret');
    expect(t.deps.workflows.versions(body.id)?.[0]?.note).toBe('first');
  });

  it('create with a Run override holding a redacted URL → HIDDEN_URL_UNKNOWN with the Run node id, nothing stored; duplicate drops URL-valued Run overrides', async () => {
    const t = app();
    const s = await login(t);
    const sub = await create(t, s, 'Sub', 'subworkflow');
    const runWith = (url: string) =>
      node('run', 'core:run-subworkflow', {
        subworkflowId: sub.id,
        version: 1,
        overrides: { 'nw.url': url, 'kl.languages': ['en'] },
      });
    const res = await send(t, 'POST', '/workflows', {
      body: { name: 'N', kind: 'workflow', graph: mainWith(runWith('https://h/…')) },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'HIDDEN_URL_UNKNOWN',
      data: { nodeIds: ['run'] },
    });
    expect(t.deps.workflows.list().map((w) => w.name)).toEqual(['Sub']);

    const src = t.deps.workflows.create(
      { name: 'Src', kind: 'workflow', graph: mainWith(runWith('https://hooks.example/s3cret')) },
      'u',
    );
    const dup = await send(t, 'POST', `/workflows/${src.id}/duplicate`, {
      body: { name: 'Copy' },
      headers: asSession(s, true),
    });
    expect(dup.status).toBe(200);
    const text = await dup.text();
    expect(text).not.toContain('s3cret');
    const body = JSON.parse(text) as Detail & { droppedWebhookUrls: string[] };
    expect(body.droppedWebhookUrls).toEqual(['run']);
    const overridesOf = (g: WorkflowGraph | undefined) =>
      (g?.nodes.find((n) => n.id === 'run')?.settings as { overrides: object } | undefined)
        ?.overrides;
    expect(overridesOf(body.graph)).toEqual({ 'kl.languages': ['en'] });
    expect(overridesOf(t.deps.workflows.get(body.id)?.graph)).toEqual({ 'kl.languages': ['en'] });
  });

  it('POST /workflows/{id}/duplicate needs workflows:write; returns the copy with sourceVersion and droppedWebhookUrls; unknown id → 404', async () => {
    const t = app();
    const s = await login(t);
    const src = await create(t, s, 'Src');
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('n', 'core:notify-webhook', { url: 'https://hooks.example/s3cret', method: 'POST' }),
    );
    expect((await save(t, s, src.id, 1, graph)).status).toBe(200);
    const dup = (id: string, headers: Record<string, string>) =>
      send(t, 'POST', `/workflows/${id}/duplicate`, { body: { name: 'Copy' }, headers });

    const { token: readToken } = await createToken(t, s);
    expect((await dup(src.id, bearer(readToken))).status).toBe(403);

    const res = await dup(src.id, asSession(s, true));
    expect(res.status).toBe(200);
    const body = await json<Detail & { sourceVersion: number; droppedWebhookUrls: string[] }>(res);
    expect(body).toMatchObject({
      name: 'Copy',
      kind: 'workflow',
      active: null,
      sourceVersion: 2,
      droppedWebhookUrls: ['n'],
    });
    // The empty URL is shown like any unusable one (redactUrl); the stored copy has ''.
    expect(body.graph.nodes.find((n) => n.id === 'n')?.settings).toEqual({
      url: 'an invalid URL',
      method: 'POST',
    });
    expect(t.deps.workflows.get(body.id)?.graph.nodes.find((n) => n.id === 'n')?.settings).toEqual({
      url: '',
      method: 'POST',
    });
    const list = await json<{ workflows: Array<{ name: string }> }>(
      await send(t, 'GET', '/workflows', { headers: asSession(s, false) }),
    );
    expect(list.workflows.map((w) => w.name)).toEqual(['Copy', 'Src']);
    expect((await dup('nope', asSession(s, true))).status).toBe(404);
  });

  it('save with a stale baseVersion → 409 VERSION_CONFLICT { currentVersion }; unknown id → 404', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    const res = await save(t, s, id, 1, mainWith(node('b', 'test:bump')));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      defined: true,
      data: { currentVersion: 2 },
    });
    const missing = await save(t, s, 'nope', 1, mainWith());
    expect(missing.status).toBe(404);
    expect((await json<{ code: string }>(missing)).code).toBe('NOT_FOUND');
  });

  it('save with a structurally broken graph → 400; save with an invalid-but-parsable graph → 200 with issues and valid false', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    const broken = await save(t, s, id, 1, { formatVersion: 1, kind: 'workflow', nodes: [] });
    expect(broken.status).toBe(400);
    const res = await save(t, s, id, 1, mainWith(node('x', 'test:nope')));
    expect(res.status).toBe(200);
    const body = await json<{ version: number; valid: boolean; issues: Detail['issues'] }>(res);
    expect(body).toMatchObject({ version: 2, valid: false });
    expect(codes(body.issues)).toContain('error:UNKNOWN_NODE_TYPE');
  });

  it('save with a graph of the other kind → 400 KIND_MISMATCH (defined) and no new version', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    const res = await save(t, s, id, 1, childGraph());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'KIND_MISMATCH', defined: true, status: 400 });
    const got = await json<Detail>(
      await send(t, 'GET', `/workflows/${id}`, { headers: asSession(s, false) }),
    );
    expect(got.currentVersion).toBe(1);
  });

  it('validate needs only read: a read token can POST /workflows/validate; create with it → 403; with workflows:write → 200', async () => {
    const t = app();
    const s = await login(t);
    const me = await json<{ user: { id: string } }>(
      await send(t, 'GET', '/auth/me', { headers: asSession(s, false) }),
    );
    const { token: readToken } = await createToken(t, s);
    const valid = await send(t, 'POST', '/workflows/validate', {
      body: { graph: mainWith(node('b', 'test:bump')) },
      headers: bearer(readToken),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ issues: [], valid: true });

    const denied = await send(t, 'POST', '/workflows', {
      body: { name: 'X', kind: 'workflow' },
      headers: bearer(readToken),
    });
    expect(denied.status).toBe(403);
    expect((await json<{ code: string }>(denied)).code).toBe('FORBIDDEN');

    const { token: writeToken } = await createToken(t, s, {
      name: 'w',
      scopes: ['workflows:write'],
    });
    const ok = await send(t, 'POST', '/workflows', {
      body: { name: 'X', kind: 'workflow' },
      headers: bearer(writeToken),
    });
    expect(ok.status).toBe(200);
    const { id } = await json<Detail>(ok);
    const versions = await json<{ versions: Array<{ createdBy: string }> }>(
      await send(t, 'GET', `/workflows/${id}/versions`, { headers: asSession(s, false) }),
    );
    expect(versions.versions[0]?.createdBy).toBe(me.user.id);
    // a write-only token cannot read
    expect((await send(t, 'GET', '/workflows', { headers: bearer(writeToken) })).status).toBe(403);
  });

  it('validate passes id as selfId: a sub-workflow running itself is a reference cycle only with id', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Sub', 'subworkflow');
    expect((await save(t, s, id, 1, childGraph())).status).toBe(200);
    const graph = chain('subworkflow', run('r', id, 2));
    const validate = async (body: Record<string, unknown>) =>
      codes(
        (
          await json<{ issues: Detail['issues'] }>(
            await send(t, 'POST', '/workflows/validate', { body, headers: asSession(s, true) }),
          )
        ).issues,
      );
    expect(await validate({ graph, id })).toContain('error:SUBWORKFLOW_REFERENCE_CYCLE');
    expect(await validate({ graph })).not.toContain('error:SUBWORKFLOW_REFERENCE_CYCLE');
  });

  it('POST /workflows/{id}/activate: a session activates v2; invalid → 422 WORKFLOW_INVALID with issues; confirm missing → 400; unknown version → 404', async () => {
    const t = app();
    const s = await login(t);
    const me = await json<{ user: { id: string } }>(
      await send(t, 'GET', '/auth/me', { headers: asSession(s, false) }),
    );
    const { id } = await create(t, s, 'Main');
    const activate = (body: Record<string, unknown>, wid = id) =>
      send(t, 'POST', `/workflows/${wid}/activate`, { body, headers: asSession(s, true) });

    expect((await activate({ version: 1 })).status).toBe(400);
    const invalid = await activate({ version: 1, confirm: true });
    expect(invalid.status).toBe(422);
    const invalidBody = await json<{ code: string; data: { issues: Detail['issues'] } }>(invalid);
    expect(invalidBody.code).toBe('WORKFLOW_INVALID');
    expect(codes(invalidBody.data.issues)).toContain('error:TRIGGER_COUNT');

    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    const ok = await activate({ version: 2, confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id,
      active: { version: 2, runnable: true, activatedBy: me.user.id },
    });
    const missing = await activate({ version: 9, confirm: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Workflow version not found',
    });
    expect((await activate({ version: 1, confirm: true }, 'nope')).status).toBe(404);
  });

  it('POST /workflows/{id}/activate: a library another workflow feeds → 409 LIBRARY_TAKEN; a missing library → 400 LIBRARY_MISSING', async () => {
    const t = app();
    const s = await login(t);
    insertLibrary(
      t.db,
      {
        id: 'shows',
        name: 'Shows',
        path: '/media/shows',
        recycleFolder: null,
        processHardlinked: false,
      },
      new Date(),
    );
    const fromLibrary = (libraryId: string) =>
      chain(
        'workflow',
        node('in', 'core:input-library', { libraryId }),
        node('ro', 'core:replace-original'),
      );
    const activate = (wid: string) =>
      send(t, 'POST', `/workflows/${wid}/activate`, {
        body: { version: 2, confirm: true },
        headers: asSession(s, true),
      });
    const a = await create(t, s, 'Downsize');
    const b = await create(t, s, 'Other');
    const c = await create(t, s, 'Lost');
    expect((await save(t, s, a.id, 1, fromLibrary('shows'))).status).toBe(200);
    expect((await save(t, s, b.id, 1, fromLibrary('shows'))).status).toBe(200);
    expect((await save(t, s, c.id, 1, fromLibrary('gone'))).status).toBe(200);
    expect((await activate(a.id)).status).toBe(200);

    const taken = await activate(b.id);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({
      code: 'LIBRARY_TAKEN',
      message: 'Shows is fed by Downsize v2. Deactivate it or point this Library input elsewhere.',
      data: {
        library: { id: 'shows', name: 'Shows' },
        workflow: { id: a.id, name: 'Downsize', version: 2 },
      },
    });
    const missing = await activate(c.id);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      code: 'LIBRARY_MISSING',
      data: { libraryId: 'gone' },
    });
  });

  it('create with a Library input graph is as valid as saving the same graph', async () => {
    const t = app();
    const s = await login(t);
    insertLibrary(
      t.db,
      {
        id: 'shows',
        name: 'Shows',
        path: '/media/shows',
        recycleFolder: null,
        processHardlinked: false,
      },
      new Date(),
    );
    const graph = chain(
      'workflow',
      node('in', 'core:input-library', { libraryId: 'shows' }),
      node('ro', 'core:replace-original'),
    );
    const res = await send(t, 'POST', '/workflows', {
      body: { name: 'Downsize', kind: 'workflow', graph },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    const created = await json<Detail>(res);
    expect(created.issues).toEqual([]);
    expect(created.valid).toBe(true);
    const other = await create(t, s, 'Other');
    const saved = await save(t, s, other.id, 1, graph);
    expect(saved.status).toBe(200);
    expect((await json<Detail>(saved)).issues).toEqual(created.issues);
  });

  it('activate and deactivate on a sub-workflow → 400 KIND_MISMATCH (defined)', async () => {
    const t = app();
    const s = await login(t);
    const sub = await create(t, s, 'Sub', 'subworkflow');
    for (const [path, body] of [
      ['activate', { version: 1, confirm: true }],
      ['deactivate', {}],
    ] as const) {
      const res = await send(t, 'POST', `/workflows/${sub.id}/${path}`, {
        body,
        headers: asSession(s, true),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'KIND_MISMATCH', defined: true });
    }
    expect(t.deps.workflows.get(sub.id)?.active).toBeNull();
  });

  it('activate and deactivate refuse every token, even with every scope, with or without a session cookie', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    const { token } = await createToken(t, s, {
      name: 'all',
      scopes: ['read', 'plan', 'jobs:create', 'jobs:manage', 'workflows:write'],
    });
    const calls = [
      ['activate', { version: 2, confirm: true }],
      ['deactivate', {}],
    ] as const;
    for (const [path, body] of calls) {
      const alone = await send(t, 'POST', `/workflows/${id}/${path}`, {
        body,
        headers: bearer(token),
      });
      expect(alone.status).toBe(403);
      expect(await alone.json()).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Activation is a UI action',
      });
      // The bearer is authoritative: the cookie is never silently used to activate.
      const both = await send(t, 'POST', `/workflows/${id}/${path}`, {
        body,
        headers: { ...asSession(s, true), ...bearer(token) },
      });
      expect(both.status).toBe(403);
      expect((await json<{ code: string }>(both)).code).toBe('FORBIDDEN');
    }
    expect(t.deps.workflows.get(id)?.active).toBeNull();
    const anon = await send(t, 'POST', `/workflows/${id}/activate`, {
      body: { version: 2, confirm: true },
    });
    expect(anon.status).toBe(401);
  });

  it('activate without the CSRF header → 403 CSRF_FAILED and active stays null', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    const res = await send(t, 'POST', `/workflows/${id}/activate`, {
      body: { version: 2, confirm: true },
      headers: { cookie: `${SESSION_COOKIE}=${s.cookie}`, origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe('CSRF_FAILED');
    expect(t.deps.workflows.get(id)?.active).toBeNull();
  });

  it('POST /workflows/{id}/deactivate → 200 active null; again → 200 (no-op); jobs rows untouched', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    const on = await send(t, 'POST', `/workflows/${id}/activate`, {
      body: { version: 2, confirm: true },
      headers: asSession(s, true),
    });
    expect(on.status).toBe(200);
    const jobsBefore = t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    const off = () =>
      send(t, 'POST', `/workflows/${id}/deactivate`, { body: {}, headers: asSession(s, true) });
    for (let i = 0; i < 2; i++) {
      const res = await off();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, active: null });
    }
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual(jobsBefore);
    expect(
      (
        await send(t, 'POST', '/workflows/nope/deactivate', {
          body: {},
          headers: asSession(s, true),
        })
      ).status,
    ).toBe(404);
  });

  it('save returns active (unchanged) and changes; a save with errors → 200, valid false, active unchanged', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith())).status).toBe(200);
    expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
    const g = mainWith(node('b', 'test:bump'));
    const res = await save(t, s, id, 2, g);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: 3,
      valid: true,
      active: { version: 2, runnable: true },
      changes: expect.any(Array),
    });
    const bad = await save(t, s, id, 3, { ...g, edges: g.edges.slice(1) });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({
      version: 4,
      valid: false,
      active: { version: 2 },
    });
    expect(t.deps.workflows.get(id)?.active?.version).toBe(2);
  });

  it('save with restoredFrom reaches the service: a restored v1 with an outdated node comes back upgraded', async () => {
    const t = app({ nodes: testRegistry(bumpV2()).list() });
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith(node('b', 'test:bump', { level: 1 })))).status).toBe(
      200,
    );
    const res = await send(t, 'PUT', `/workflows/${id}`, {
      body: {
        baseVersion: 2,
        graph: mainWith(node('b', 'test:bump', { level: 1 })),
        restoredFrom: 2,
      },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    const got = t.deps.workflows.get(id);
    expect(got?.graph.nodes.find((n) => n.id === 'b')?.typeVersion).toBe(2);
  });

  it('create and duplicate answer active null (duplicate of an active source: source stays active, copy null)', async () => {
    const t = app();
    const s = await login(t);
    const src = await create(t, s, 'Src');
    expect(src.active).toBeNull();
    expect((await save(t, s, src.id, 1, mainWith())).status).toBe(200);
    expect(t.deps.workflows.activate(src.id, 2, 'u').kind).toBe('ok');
    const res = await send(t, 'POST', `/workflows/${src.id}/duplicate`, {
      body: { name: 'Copy' },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    expect((await json<Detail>(res)).active).toBeNull();
    expect(t.deps.workflows.get(src.id)?.active?.version).toBe(2);
  });

  it('rename → 200 and no new version; delete in-use → 409 IN_USE with usedBy; delete → 200 then get → 404', async () => {
    const t = app();
    const s = await login(t);
    const sub = await create(t, s, 'Sub', 'subworkflow');
    expect((await save(t, s, sub.id, 1, childGraph())).status).toBe(200);
    const parent = await create(t, s, 'Parent');
    expect((await save(t, s, parent.id, 1, mainWith(run('r', sub.id, 2)))).status).toBe(200);

    const renamed = await send(t, 'PATCH', `/workflows/${sub.id}`, {
      body: { name: 'Renamed' },
      headers: asSession(s, true),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: sub.id, name: 'Renamed', currentVersion: 2 });
    const subVersions = await json<{ versions: unknown[] }>(
      await send(t, 'GET', `/workflows/${sub.id}/versions`, { headers: asSession(s, false) }),
    );
    expect(subVersions.versions).toHaveLength(2);
    expect(
      (
        await send(t, 'PATCH', '/workflows/nope', {
          body: { name: 'X' },
          headers: asSession(s, true),
        })
      ).status,
    ).toBe(404);

    const del = (id: string) =>
      send(t, 'DELETE', `/workflows/${id}`, { headers: asSession(s, true) });
    const inUse = await del(sub.id);
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({
      code: 'IN_USE',
      data: { usedBy: [{ id: parent.id, name: 'Parent' }] },
    });

    const deleted = await del(parent.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(
      (await send(t, 'GET', `/workflows/${parent.id}`, { headers: asSession(s, false) })).status,
    ).toBe(404);
    expect((await del(parent.id)).status).toBe(404);
    expect((await del(sub.id)).status).toBe(200);
  });

  it('session mutation without CSRF → 403 CSRF_FAILED', async () => {
    const t = app();
    const s = await login(t);
    const res = await send(t, 'POST', '/workflows', {
      body: { name: 'X', kind: 'workflow' },
      headers: { cookie: `${SESSION_COOKIE}=${s.cookie}`, origin: ORIGIN },
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe('CSRF_FAILED');
  });

  it('get on a corrupt stored graph → 500 and exactly one error log line (REST and RPC); expected errors are not logged', async () => {
    const log = {
      info: vi.fn<Logger['info']>(),
      warn: vi.fn<Logger['warn']>(),
      error: vi.fn<Logger['error']>(),
    };
    const t = app({ log });
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 1')
      .run('{"formatVersion":1', id);
    expect((await send(t, 'GET', '/workflows/nope', { headers: asSession(s, false) })).status).toBe(
      404,
    );
    expect((await send(t, 'GET', `/workflows/${id}`)).status).toBe(401);
    expect(log.error).not.toHaveBeenCalled();

    const res = await send(t, 'GET', `/workflows/${id}`, { headers: asSession(s, false) });
    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({
      msg: 'rpc procedure failed',
      procedure: 'workflows.get',
      error: expect.stringMatching(/^CorruptGraphError: Workflow .* version 1 could not be read/),
    });

    log.error.mockClear();
    const rpc = await t.app.request('/rpc/workflows/get', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json', ...asSession(s, false) },
      body: JSON.stringify({ json: { id } }),
    });
    expect(rpc.status).toBe(500);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ procedure: 'workflows.get' }));
  });
});

describe('workflows procedures: webhook URLs are write-only (final review I6)', () => {
  const SECRET = 'tok3n-s3cret';
  const hook = `https://hooks.example/${SECRET}?k=${SECRET}`;
  const notify = (url: string) => node('nw', 'core:notify-webhook', { url, method: 'POST' });

  it('get shows the notify URL and URL-valued Run overrides as scheme and host only, to a read token too', async () => {
    const t = app();
    const s = await login(t);
    const sub = await create(t, s, 'Sub', 'subworkflow');
    expect((await save(t, s, sub.id, 1, chain('subworkflow', notify(hook)))).status).toBe(200);
    const { id } = await create(t, s, 'Main');
    const runNode = node('run', 'core:run-subworkflow', {
      subworkflowId: sub.id,
      version: 2,
      overrides: { 'nw.url': hook },
    });
    expect((await save(t, s, id, 1, mainWith(runNode, notify(hook)))).status).toBe(200);

    const { token } = await createToken(t, s);
    for (const headers of [asSession(s, false), bearer(token)]) {
      const res = await send(t, 'GET', `/workflows/${id}`, { headers });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      const body = JSON.parse(text) as Detail;
      const settings = (nodeId: string) => body.graph.nodes.find((n) => n.id === nodeId)?.settings;
      expect(settings('nw')).toEqual({ url: 'https://hooks.example/…', method: 'POST' });
      expect(settings('run')).toMatchObject({ overrides: { 'nw.url': 'https://hooks.example/…' } });
    }
    // A sub-workflow's settings list shows the redacted value as the default.
    const subRes = await send(t, 'GET', `/workflows/${sub.id}`, { headers: asSession(s, false) });
    const subText = await subRes.text();
    expect(subText).not.toContain(SECRET);
    const subBody = JSON.parse(subText) as { settings: Array<{ key: string; default: unknown }> };
    expect(subBody.settings.find((x) => x.key === 'nw.url')?.default).toBe(
      'https://hooks.example/…',
    );
  });

  it('save keeps the stored URL when the redacted form comes back unchanged; a new URL replaces it', async () => {
    const t = app();
    const s = await login(t);
    const sub = await create(t, s, 'Sub', 'subworkflow');
    expect((await save(t, s, sub.id, 1, chain('subworkflow', notify(hook)))).status).toBe(200);
    const { id } = await create(t, s, 'Main');
    const runNode = node('run', 'core:run-subworkflow', {
      subworkflowId: sub.id,
      version: 2,
      overrides: { 'nw.url': hook },
    });
    expect((await save(t, s, id, 1, mainWith(runNode, notify(hook)))).status).toBe(200);

    // The editor loads the redacted graph and saves it back with an unrelated change.
    const got = await json<Detail>(
      await send(t, 'GET', `/workflows/${id}`, { headers: asSession(s, false) }),
    );
    const edited = { ...got.graph, nodes: [...got.graph.nodes, node('b', 'test:bump')] };
    const res = await save(t, s, id, 2, edited);
    expect(res.status).toBe(200);
    expect(await json<{ valid: boolean; version: number }>(res)).toMatchObject({ version: 3 });
    const stored = t.deps.workflows.get(id)?.graph;
    const settings = (nodeId: string) => stored?.nodes.find((n) => n.id === nodeId)?.settings;
    expect(settings('nw')).toEqual({ url: hook, method: 'POST' });
    expect(settings('run')).toMatchObject({ overrides: { 'nw.url': hook } });
    expect(stored?.nodes.some((n) => n.id === 'b')).toBe(true);

    // A new URL is stored as sent.
    const fresh = 'https://other.example/new';
    const replaced = {
      ...edited,
      nodes: edited.nodes.map((n) =>
        n.id === 'nw' ? { ...n, settings: { url: fresh, method: 'POST' } } : n,
      ),
    };
    expect((await save(t, s, id, 3, replaced)).status).toBe(200);
    expect(t.deps.workflows.get(id)?.graph.nodes.find((n) => n.id === 'nw')?.settings).toEqual({
      url: fresh,
      method: 'POST',
    });
  });
  // Final review I4: a redacted value is matched against the same node across the versions.
  const nodeUrl = (t: TestApp, id: string) => {
    const settings = t.deps.workflows.get(id)?.graph.nodes.find((n) => n.id === 'nw')?.settings;
    return (settings as { url?: string } | undefined)?.url;
  };
  const withUrl = (graph: WorkflowGraph, url: string): WorkflowGraph => ({
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === 'nw' ? { ...n, settings: { url, method: 'POST' } } : n,
    ),
  });

  it("restoring a past version (restoredFrom) stores that version's URL, not the redacted literal", async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    const old = `https://old.example/${SECRET}`;
    const rotated = `https://old.example/rotated-${SECRET}`;
    expect((await save(t, s, id, 1, mainWith(notify(old)))).status).toBe(200); // v2
    expect((await save(t, s, id, 2, mainWith(notify('https://new.example/x')))).status).toBe(200);
    expect((await save(t, s, id, 3, mainWith(notify(rotated)))).status).toBe(200); // v4

    const v2 = await json<Detail>(
      await send(t, 'GET', `/workflows/${id}?version=2`, { headers: asSession(s, false) }),
    );
    expect(JSON.stringify(v2.graph)).not.toContain(SECRET);
    const res = await send(t, 'PUT', `/workflows/${id}`, {
      body: { baseVersion: 4, graph: v2.graph, note: 'Restored from v2', restoredFrom: 2 },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    // Same host as v4's URL, but v2's own value (restoredFrom wins over the newest match).
    expect(nodeUrl(t, id)).toBe(old);
  });

  it('save over a newer version: a redacted URL that only an older version has is restored from it', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    const old = `https://old.example/${SECRET}`;
    expect((await save(t, s, id, 1, mainWith(notify(old)))).status).toBe(200); // v2
    const loaded = await json<Detail>(
      await send(t, 'GET', `/workflows/${id}`, { headers: asSession(s, false) }),
    );
    // Someone else changes the URL's host (v3); this draft saves over it with the v2 value.
    expect((await save(t, s, id, 2, mainWith(notify('https://new.example/y')))).status).toBe(200);
    const res = await save(t, s, id, 3, loaded.graph);
    expect(res.status).toBe(200);
    expect(nodeUrl(t, id)).toBe(old);
  });

  it('a redacted URL that matches no stored version → 400 HIDDEN_URL_UNKNOWN, nothing stored', async () => {
    const t = app();
    const s = await login(t);
    const { id } = await create(t, s, 'Main');
    expect((await save(t, s, id, 1, mainWith(notify(hook)))).status).toBe(200);
    const res = await save(t, s, id, 2, withUrl(mainWith(notify(hook)), 'https://never.example/…'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'HIDDEN_URL_UNKNOWN',
      defined: true,
      data: { nodeIds: ['nw'] },
    });
    expect(t.deps.workflows.get(id)?.currentVersion).toBe(2);
    expect(nodeUrl(t, id)).toBe(hook);
  });
});
