import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test-app.ts';
import { asSession, login, type Session, send, withCsrf } from '../test-http.ts';
import { languageCleanupSub, tiggerPoohMain } from './fixtures/tigger-pooh.ts';
import { bumpV1, bumpV2, bumpV3, node, testRegistry } from './test-helpers.ts';

interface Detail {
  id: string;
  version: number;
  currentVersion: number;
  active: { version: number; runnable: boolean } | null;
  activeIssues: Issue[];
  valid: boolean;
  issues: Issue[];
  graph: WorkflowGraph;
  settings: Array<{ key: string; default: unknown }> | null;
}
interface Summary {
  id: string;
  active: { version: number; runnable: boolean } | null;
  errorCount: number;
  usesOutdatedSubworkflow: boolean;
  usedBy: Array<{ id: string; name: string }>;
}
interface Saved {
  version: number;
  valid: boolean;
  issues: Issue[];
  active: { version: number; runnable: boolean } | null;
}

const MAIN_NAME = 'Tigger & Pooh cleanup';
const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}@${i.nodeId}`);
const has = (issues: Issue[], code: string, nodeId: string) =>
  issues.some((i) => i.code === code && i.nodeId === nodeId);

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('workflow contract scenario: Tigger & Pooh', () => {
  const t = createTestApp({ nodes: testRegistry(bumpV1()).list() });
  let s: Session;
  let subId = '';
  let mainId = '';
  let fixed: WorkflowGraph;

  const create = async (app: TestApp, name: string, kind: 'workflow' | 'subworkflow') => {
    const res = await send(app, 'POST', '/workflows', {
      body: { name, kind },
      headers: asSession(s, true),
    });
    expect(res.status).toBe(200);
    return json<Detail>(res);
  };
  const put = (app: TestApp, id: string, baseVersion: number, graph: WorkflowGraph) =>
    send(app, 'PUT', `/workflows/${id}`, {
      body: { baseVersion, graph },
      headers: asSession(s, true),
    });
  const get = async (app: TestApp, id: string) => {
    const res = await send(app, 'GET', `/workflows/${id}`, { headers: asSession(s, false) });
    expect(res.status).toBe(200);
    return json<Detail>(res);
  };
  const list = async (app: TestApp) =>
    (
      await json<{ workflows: Summary[] }>(
        await send(app, 'GET', '/workflows', { headers: asSession(s, false) }),
      )
    ).workflows;
  const activate = (app: TestApp, body: Record<string, unknown>) =>
    send(app, 'POST', `/workflows/${mainId}/activate`, { body, headers: asSession(s, true) });

  it('1. creates and saves the shared sub-workflow', async () => {
    s = await login(t);
    const created = await create(t, 'Language cleanup', 'subworkflow');
    subId = created.id;
    const res = await put(t, subId, 1, languageCleanupSub());
    expect(res.status).toBe(200);
    expect((await json<Saved>(res)).version).toBe(2);
    const got = await get(t, subId);
    expect(got.valid).toBe(true);
    expect(got.settings?.find((x) => x.key === 'keep.languages')?.default).toEqual(['en', 'de']);
  });

  it('2. saves the main workflow pinned to version 2', async () => {
    mainId = (await create(t, MAIN_NAME, 'workflow')).id;
    fixed = tiggerPoohMain(subId, 2, {
      extraNodes: [node('bump', 'test:bump', { level: 1 })],
    });
    const res = await put(t, mainId, 1, fixed);
    expect(res.status).toBe(200);
    expect(await json<Saved>(res)).toMatchObject({ version: 2, valid: true, issues: [] });
  });

  it('3. an invalid draft saves with issues and shows in the list', async () => {
    const draft = { ...fixed, edges: fixed.edges.filter((e) => e.id !== 'ca-sg') };
    const res = await put(t, mainId, 2, draft);
    expect(res.status).toBe(200);
    const body = await json<Saved>(res);
    expect(body.valid).toBe(false);
    expect(codes(body.issues)).toEqual(
      expect.arrayContaining([
        'error:INPUT_UNCONNECTED@sg',
        'warning:NODE_UNREACHABLE@sg',
        'warning:NODE_UNREACHABLE@ro-a',
      ]),
    );
    expect((await list(t)).find((w) => w.id === mainId)?.errorCount).toBe(1);
  });

  it('4. the fixed graph validates and saves as version 4', async () => {
    const v = await send(t, 'POST', '/workflows/validate', {
      body: { graph: fixed },
      headers: asSession(s, true),
    });
    expect((await json<{ valid: boolean }>(v)).valid).toBe(true);
    const res = await put(t, mainId, 3, fixed);
    expect(res.status).toBe(200);
    expect((await json<Saved>(res)).version).toBe(4);
  });

  it('5. activating needs confirm', async () => {
    expect((await activate(t, { version: 4 })).status).toBe(400);
    const res = await activate(t, { version: 4, confirm: true });
    expect(res.status).toBe(200);
    expect((await json<Summary>(res)).active).toMatchObject({ version: 4, runnable: true });
  });

  let t2: TestApp;
  it('6. a safe node upgrade adds a version and keeps v4 active', async () => {
    t2 = createTestApp({ db: t.db, nodes: testRegistry(bumpV2()).list() });
    expect(t2.deps.workflows.upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 0,
      broken: 0,
      unchanged: 1,
    });
    s = await withCsrf(t2, s.cookie);
    const got = await get(t2, mainId);
    expect(got).toMatchObject({
      currentVersion: 5,
      active: { version: 4, runnable: true },
      activeIssues: [],
    });
    const bump = got.graph.nodes.find((n) => n.id === 'bump');
    expect(bump).toMatchObject({ typeVersion: 2, settings: { level: 1, label: '' } });
    const versions = await json<{ versions: Array<Record<string, unknown>> }>(
      await send(t2, 'GET', `/workflows/${mainId}/versions`, { headers: asSession(s, false) }),
    );
    expect(versions.versions).toContainEqual(
      expect.objectContaining({
        version: 5,
        note: 'Updated Bump 1→2',
        createdBy: 'system:upgrade',
      }),
    );
  });

  let t3: TestApp;
  it('7. a behaviour upgrade makes the active version unrunnable until a runnable one is activated', async () => {
    t3 = createTestApp({ db: t.db, nodes: testRegistry(bumpV3()).list() });
    expect(t3.deps.workflows.upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 1,
      broken: 0,
      unchanged: 1,
    });
    s = await withCsrf(t3, s.cookie);
    const got = await get(t3, mainId);
    expect(got).toMatchObject({ currentVersion: 6, active: { version: 4, runnable: false } });
    expect(got.activeIssues).toHaveLength(1);
    expect(got.activeIssues[0]).toMatchObject({ code: 'NODE_OUTDATED', nodeId: 'bump' });

    // The same check refuses to activate the held version again.
    const again = await activate(t3, { version: 4, confirm: true });
    expect(again.status).toBe(422);
    expect((await json<{ code: string }>(again)).code).toBe('WORKFLOW_INVALID');

    const on = await activate(t3, { version: 6, confirm: true });
    expect(on.status).toBe(200);
    expect((await json<Summary>(on)).active).toMatchObject({ version: 6, runnable: true });
    expect((await get(t3, mainId)).activeIssues).toEqual([]);
  });

  it('8. a new sub-workflow version marks the pinned parent outdated', async () => {
    const changed = {
      ...languageCleanupSub(),
    };
    changed.nodes = changed.nodes.map((n) =>
      n.id === 'keep'
        ? { ...n, settings: { languages: ['en'], keepOriginal: true, keepUntagged: true } }
        : n,
    );
    const res = await put(t3, subId, 2, changed);
    expect(res.status).toBe(200);
    expect((await json<Saved>(res)).version).toBe(3);

    const all = await list(t3);
    expect(all.find((w) => w.id === mainId)?.usesOutdatedSubworkflow).toBe(true);
    expect(all.find((w) => w.id === subId)?.usedBy).toEqual([{ id: mainId, name: MAIN_NAME }]);

    const got = await get(t3, mainId);
    expect(has(got.issues, 'SUBWORKFLOW_OUTDATED', 'run-a')).toBe(true);
    expect(has(got.issues, 'SUBWORKFLOW_OUTDATED', 'run-b')).toBe(true);
    for (const id of ['run-a', 'run-b']) {
      expect(got.graph.nodes.find((n) => n.id === id)?.settings).toMatchObject({ version: 2 });
    }
  });

  it('9. saving an updated pin adds a version and leaves v6 active', async () => {
    const got = await get(t3, mainId);
    const graph: WorkflowGraph = {
      ...got.graph,
      nodes: got.graph.nodes.map((n) =>
        n.id === 'run-a' || n.id === 'run-b'
          ? { ...n, settings: { ...(n.settings as Record<string, unknown>), version: 3 } }
          : n,
      ) as WorkflowGraph['nodes'],
    };
    const res = await put(t3, mainId, 6, graph);
    expect(res.status).toBe(200);
    const body = await json<Saved>(res);
    expect(body).toMatchObject({ version: 7, active: { version: 6, runnable: true } });
    expect(body.issues.some((i) => i.code === 'SUBWORKFLOW_OUTDATED')).toBe(false);
  });

  it('10. deleting needs the parent gone first', async () => {
    const blocked = await send(t3, 'DELETE', `/workflows/${subId}`, {
      headers: asSession(s, true),
    });
    expect(blocked.status).toBe(409);
    expect(await json<{ code: string; data: unknown }>(blocked)).toMatchObject({
      code: 'IN_USE',
      data: { usedBy: [{ id: mainId, name: MAIN_NAME }] },
    });
    for (const id of [mainId, subId]) {
      const res = await send(t3, 'DELETE', `/workflows/${id}`, { headers: asSession(s, true) });
      expect(res.status).toBe(200);
    }
    expect(await list(t3)).toEqual([]);
  });
});
