import type { JsonValue, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { insertLibrary } from '../../db/repos/libraries.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, createToken, login, type Session, send } from '../../test-http.ts';
import {
  bumpV1,
  chain,
  childGraph,
  edge,
  mainGraph,
  node,
  testRegistry,
} from '../../workflows/test-helpers.ts';
import { mcpClient } from '../test-client.ts';
import { workflowReadTools } from './workflows-read.ts';

const SECRET = 'hook-secret-7f3a';

const text = (res: unknown) =>
  ((res as { content?: { text: string }[] }).content ?? [])[0]?.text ?? '';

async function setup() {
  const t = createTestApp({ nodes: testRegistry(bumpV1()).list(), mcpTools: workflowReadTools });
  const s = await login(t);
  const { token } = await createToken(t, s, { name: 'r', scopes: ['read'] });
  return { t, s, client: await mcpClient(t, token) };
}

async function createWorkflow(t: TestApp, s: Session, name: string, graph?: WorkflowGraph) {
  const res = await send(t, 'POST', '/workflows', {
    body: { name, kind: 'workflow' },
    headers: asSession(s, true),
  });
  const created = (await res.json()) as { id: string };
  if (graph) {
    const saved = await send(t, 'PUT', `/workflows/${created.id}`, {
      body: { baseVersion: 1, graph, note: 'with hook' },
      headers: asSession(s, true),
    });
    expect(saved.status).toBe(200);
  }
  return created.id;
}

const hookGraph = (): WorkflowGraph =>
  chain(
    'workflow',
    node('in', 'core:input-manual'),
    node('n', 'core:notify-webhook', {
      url: `https://hooks.example/t?token=${SECRET}`,
    } as JsonValue),
    node('ro', 'core:replace-original'),
  );

describe('workflow read tools', () => {
  it('list_workflows and get_workflow return the redacted graph and issues; text names the node and the version', async () => {
    const { t, s, client } = await setup();
    const id = await createWorkflow(t, s, 'Hooked', hookGraph());
    const list = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(list.structuredContent).toMatchObject({ workflows: [{ id, name: 'Hooked' }] });
    expect(text(list)).toContain('1 workflow(s)');

    const res = await client.callTool({ name: 'get_workflow', arguments: { id } });
    const graph = (res.structuredContent as { graph: WorkflowGraph }).graph;
    const n = graph.nodes.find((x) => x.id === 'n');
    expect(n?.settings).toEqual({ url: 'https://hooks.example/…' });
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(text(res)).toContain('Version 2 of 2');
    expect(text(res)).toContain('- n: core:notify-webhook v1');
  });

  it('get_workflow of a past version and of an unknown id (isError NOT_FOUND); list_workflow_versions lists notes', async () => {
    const { t, s, client } = await setup();
    const id = await createWorkflow(t, s, 'Hooked', hookGraph());
    const v1 = await client.callTool({ name: 'get_workflow', arguments: { id, version: 1 } });
    expect(v1.structuredContent).toMatchObject({ version: 1, currentVersion: 2 });
    expect(text(v1)).toContain('Version 1 of 2');

    const missing = await client.callTool({ name: 'get_workflow', arguments: { id: 'nope' } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^NOT_FOUND: /);

    const versions = await client.callTool({
      name: 'list_workflow_versions',
      arguments: { id },
    });
    expect(versions.structuredContent).toMatchObject({
      versions: [{ version: 2, note: 'with hook' }, { version: 1 }],
    });
    expect(text(versions)).toContain('— with hook');
  });

  it('list_nodes gives briefs with port ids and availability; with type it includes the settings schema; unknown type is NOT_FOUND', async () => {
    const { client } = await setup();
    const all = await client.callTool({ name: 'list_nodes', arguments: {} });
    const nodes = (all.structuredContent as { nodes: Record<string, unknown>[] }).nodes;
    const brief = nodes.find((x) => x.type === 'core:video-is');
    expect(brief).toMatchObject({ inputs: ['file'], outputs: ['pass', 'else'], available: true });
    expect(brief).not.toHaveProperty('settingsSchema');
    expect(text(all)).toContain('core:video-is (condition)');

    const one = await client.callTool({
      name: 'list_nodes',
      arguments: { type: 'core:run-subworkflow' },
    });
    const only = (one.structuredContent as { nodes: { settingsSchema: unknown }[] }).nodes;
    expect(only).toHaveLength(1);
    expect(only[0]?.settingsSchema).toMatchObject({
      properties: { subworkflowId: expect.anything() },
    });

    const bad = await client.callTool({ name: 'list_nodes', arguments: { type: 'core:nope' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^NOT_FOUND: /);
  });

  it('validate_workflow reports issues without saving; a structurally broken graph (duplicate ids) is an isError input-validation result from the SDK', async () => {
    const { t, s, client } = await setup();
    const count = async () =>
      (
        (await (await send(t, 'GET', '/workflows', { headers: asSession(s, false) })).json()) as {
          workflows: unknown[];
        }
      ).workflows.length;
    const before = await count();

    const broken = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('b', 'test:bump'),
        node('ro', 'core:replace-original'),
      ],
      [edge('in', 'b')],
    );
    const res = await client.callTool({ name: 'validate_workflow', arguments: { graph: broken } });
    expect(res.structuredContent).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'INPUT_UNCONNECTED' })]),
    });
    const issues = (res.structuredContent as { issues: { severity: string }[] }).issues;
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    expect(errors).toBeGreaterThan(0);
    expect(warnings).toBeGreaterThan(0);
    expect(text(res).split('\n')[0]).toBe(`${errors} error(s), ${warnings} warning(s):`);
    expect(text(res).split('\n')).toHaveLength(1 + issues.length);

    const dup = mainGraph([node('a', 'core:input-manual'), node('a', 'core:replace-original')]);
    const bad = await client.callTool({ name: 'validate_workflow', arguments: { graph: dup } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toBeUndefined();
    expect(text(bad)).toMatch(/Input validation error/);
    expect(text(bad)).toContain('duplicate node id');
    expect(await count()).toBe(before);
  });

  it('get_workflow of a past version that holds a webhook URL is redacted', async () => {
    const { t, s, client } = await setup();
    const id = await createWorkflow(t, s, 'Hooked', hookGraph());
    // v3 drops the hook; v2 still holds it.
    const plain = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
    );
    const saved = await send(t, 'PUT', `/workflows/${id}`, {
      body: { baseVersion: 2, graph: plain },
      headers: asSession(s, true),
    });
    expect(saved.status).toBe(200);
    const res = await client.callTool({ name: 'get_workflow', arguments: { id, version: 2 } });
    expect(res.structuredContent).toMatchObject({ version: 2, currentVersion: 3 });
    const graph = (res.structuredContent as { graph: WorkflowGraph }).graph;
    expect(graph.nodes.find((x) => x.id === 'n')?.settings).toEqual({
      url: 'https://hooks.example/…',
    });
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('validate_workflow says Valid. for a clean graph and lists warnings for a valid graph that has some', async () => {
    const { client } = await setup();
    const clean = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
    );
    const ok = await client.callTool({ name: 'validate_workflow', arguments: { graph: clean } });
    expect(ok.structuredContent).toEqual({ valid: true, issues: [] });
    expect(text(ok)).toBe('Valid.');

    const warn = { ...clean, nodes: [...clean.nodes, node('d', 'test:data-language')] };
    const res = await client.callTool({ name: 'validate_workflow', arguments: { graph: warn } });
    const issues = res.structuredContent as { valid: boolean; issues: { severity: string }[] };
    expect(issues.valid).toBe(true);
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(text(res).split('\n')[0]).toBe(`0 error(s), ${issues.issues.length} warning(s):`);
  });

  it('validate_workflow with workflowId resolves sub-workflow references', async () => {
    const { t, s, client } = await setup();
    const mainId = await createWorkflow(t, s, 'Main');
    const sub = await send(t, 'POST', '/workflows', {
      body: { name: 'x', kind: 'subworkflow' },
      headers: asSession(s, true),
    });
    const child = ((await sub.json()) as { id: string }).id;
    const saved = await send(t, 'PUT', `/workflows/${child}`, {
      body: { baseVersion: 1, graph: childGraph() },
      headers: asSession(s, true),
    });
    expect(saved.status).toBe(200);
    const main = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('r', 'core:run-subworkflow', { subworkflowId: child, version: 2, overrides: {} }),
      node('ro', 'core:replace-original'),
    );
    const res = await client.callTool({
      name: 'validate_workflow',
      arguments: { graph: main, workflowId: mainId },
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ valid: true });
  });

  it('get_workflow of a sub-workflow lists its override keys', async () => {
    const { t, s, client } = await setup();
    const sub = await send(t, 'POST', '/workflows', {
      body: { name: 'Child', kind: 'subworkflow' },
      headers: asSession(s, true),
    });
    const child = ((await sub.json()) as { id: string }).id;
    const saved = await send(t, 'PUT', `/workflows/${child}`, {
      body: { baseVersion: 1, graph: childGraph() },
      headers: asSession(s, true),
    });
    expect(saved.status).toBe(200);
    const res = await client.callTool({ name: 'get_workflow', arguments: { id: child } });
    const settings = (res.structuredContent as { settings: { key: string }[] }).settings;
    expect(settings.length).toBeGreaterThan(0);
    expect(text(res)).toContain(
      `Settings (override keys): ${settings.map((x) => x.key).join(', ')}`,
    );
    expect(text(res)).toContain('never active');
  });

  it('list_workflows carries feedsLibrary and the line ends with ", feeds Shows" for the active feeder', async () => {
    const { t, s, client } = await setup();
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
    const id = await createWorkflow(
      t,
      s,
      'Downsize',
      chain(
        'workflow',
        node('in', 'core:input-library', { libraryId: 'shows' }),
        node('ro', 'core:replace-original'),
      ),
    );
    const before = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(before.structuredContent).toMatchObject({ workflows: [{ id, feedsLibrary: null }] });
    expect(text(before)).not.toContain('feeds');
    expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
    const list = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(list.structuredContent).toMatchObject({
      workflows: [{ id, feedsLibrary: { id: 'shows', name: 'Shows' } }],
    });
    expect(text(list).split('\n')[1]).toMatch(/, feeds Shows$/);
    const res = await client.callTool({ name: 'get_workflow', arguments: { id } });
    expect(text(res).split('\n')[0]).toMatch(/, feeds Shows$/);
  });

  it("workflowLine says not active / active v2 / v3 newest / (can't run); get_workflow names the active version when it differs and lists activeIssues", async () => {
    const { t, s, client } = await setup();
    const plain = () =>
      chain('workflow', node('in', 'core:input-manual'), node('ro', 'core:replace-original'));
    const id = await createWorkflow(t, s, 'Main', plain());
    const line = async () => text(await client.callTool({ name: 'list_workflows', arguments: {} }));
    expect(await line()).toContain('v2, not active');
    expect(t.deps.workflows.activate(id, 2, 'u').kind).toBe('ok');
    expect(await line()).toContain('v2, active v2,');
    const saved = await send(t, 'PUT', `/workflows/${id}`, {
      body: { baseVersion: 2, graph: plain() },
      headers: asSession(s, true),
    });
    expect(saved.status).toBe(200);
    expect(await line()).toContain('active v2, v3 newest');
    const res = await client.callTool({ name: 'get_workflow', arguments: { id } });
    expect(text(res)).toContain(
      'Active: v2 — this version is v3, not active; a person activates it in the UI.',
    );
    expect(res.structuredContent).toMatchObject({ active: { version: 2, runnable: true } });
    const listed = await client.callTool({ name: 'list_workflows', arguments: {} });
    const brief = (listed.structuredContent as { workflows: Array<Record<string, unknown>> })
      .workflows[0];
    expect(brief?.active).toEqual({ version: 2, runnable: true });
    expect(brief).not.toHaveProperty('mode');
    expect(brief).not.toHaveProperty('needsReview');
  });
});
