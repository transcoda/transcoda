import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../app/testing/app.ts';
import { findPlugin } from '../../db/repos/plugins.ts';
import { tempDir } from '../../engine/testing/fixtures.ts';
import { edge, mainGraph, node } from '../../workflows/testing.ts';
import { fixturePluginPath } from '../testing/build.ts';

import {
  alive,
  files,
  install,
  pidOf,
  refresh,
  serve,
  setup,
  until,
  update,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

describe('update', () => {
  it('a newer version takes over: new process, nodes re-registered, row updated, old files removed, plugins.changed emitted', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const oldPid = pidOf(t, 'example');
    t.events.length = 0;

    const r = await update(t, 'example', '0.2.0');
    if (!r.ok) throw new Error(r.reason);
    expect(r.plugin).toMatchObject({ version: '0.2.0', state: 'running' });
    expect(pidOf(t, 'example')).not.toBe(oldPid);
    await until(() => !alive(oldPid));
    expect(await files(t)).toEqual(['example-0.2.0.js', 'example-0.2.0.manifest.json']);
    expect(findPlugin(t.db, 'example')).toMatchObject({ version: '0.2.0' });
    expect(t.deps.nodes.get('example:note')?.source).toEqual({
      kind: 'plugin',
      name: 'example',
      version: '0.2.0',
    });
    expect(t.events.at(-1)).toEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'running',
      stateReason: null,
    });
    // The supervisor never showed a second name: only `example`.
    expect(t.deps.plugins.list().map((p) => p.name)).toEqual(['example']);
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'example 0.2.0 is already installed',
    });
  });

  it('the old process keeps running until the new one is ready; a failing new version leaves the old installed and running', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const oldPid = pidOf(t, 'example');

    // 0.2.0 whose bundle still says 0.1.0.
    await serve('example', '0.2.0', {
      edit: (c) => c.replace('version: "0.2.0"', 'version: "0.1.0"'),
    });
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'manifest in bundle says example 0.1.0, catalog says 0.2.0',
    });
    // 0.3.0 that dies in setup.
    await serve('example', '0.3.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(4);'),
    });
    expect(await update(t, 'example', '0.3.0')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: exited with code 4',
    });
    // A bad checksum.
    await serve('example', '0.4.0', { sha256: 'b'.repeat(64) });
    expect(await update(t, 'example', '0.4.0')).toEqual({ ok: false, reason: 'checksum mismatch' });

    expect(pidOf(t, 'example')).toBe(oldPid);
    expect(alive(oldPid)).toBe(true);
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
    expect(t.deps.plugins.get('example')).toMatchObject({ version: '0.1.0', state: 'running' });
    expect(findPlugin(t.db, 'example')?.version).toBe('0.1.0');
    expect(t.deps.nodes.get('example:note')?.source).toMatchObject({ version: '0.1.0' });
  });

  it('a dev plugin cannot be updated or removed', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(await update(t, 'example', '0.2.0')).toMatchObject({ ok: false });
    await expect(t.deps.plugins.remove('example')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('plugin-aware updates [activation]', () => {
  const USER = 'u';
  // What the 0.2.0 release serves (the bundle announces the same through its host).
  const NEXT_NODE_VERSIONS = [
    {
      type: 'versioned:thing',
      version: 4,
      migrations: [
        { from: 2, to: 3, risk: 'behaviour' as const },
        { from: 3, to: 4, risk: 'safe' as const },
      ],
    },
  ];
  const thingGraph = (typeVersion: number, settings: Record<string, string>) =>
    mainGraph(
      [
        node('in', 'core:input-manual'),
        node('t', 'versioned:thing', settings, { typeVersion }),
        node('ro', 'core:replace-original'),
      ],
      [edge('in', 't'), edge('t', 'ro', { from: 'pass' })],
    );

  async function installed() {
    await serve('versioned');
    await serve('versioned2', '0.2.0', { manifest: { nodeVersions: NEXT_NODE_VERSIONS } });
    const t = setup();
    await t.deps.plugins.start();
    const r = await install(t, 'versioned');
    if (!r.ok) throw new Error(r.reason);
    return t;
  }

  /**
   * A workflow whose active version (2) is a graph pinned to `typeVersion`. Activation refuses a
   * version held for review, so the graph is activated current and then rewritten in the database,
   * as an older release's data would be.
   */
  function activeWorkflow(t: TestApp, name: string, typeVersion: number, settings = { old: 'a' }) {
    const wf = t.deps.workflows.create({ name, kind: 'workflow' }, USER);
    const saved = t.deps.workflows.save(
      { id: wf.id, baseVersion: wf.version, graph: thingGraph(3, { value: 'x' }) },
      USER,
    );
    expect(t.deps.workflows.activate(wf.id, saved.version, USER)).toMatchObject({ kind: 'ok' });
    t.db
      .prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = ?')
      .run(JSON.stringify(thingGraph(typeVersion, settings)), wf.id, saved.version);
    return wf.id;
  }

  it('updateCheck lists the workflow whose active version a dropped node version breaks, and the one that gets a version to review', async () => {
    const t = await installed();
    const breaks = activeWorkflow(t, 'Breaks', 1);
    const wfReview = t.deps.workflows.create({ name: 'Review', kind: 'workflow' }, USER);
    t.deps.workflows.save(
      { id: wfReview.id, baseVersion: 1, graph: thingGraph(2, { mid: 'a' }) },
      USER,
    );
    const fine = activeWorkflow(t, 'Fine', 3, { value: 'x' } as never);
    const held = activeWorkflow(t, 'Held', 2, { mid: 'a' } as never);
    await refresh(t);
    const check = await t.deps.plugins.updateCheck('versioned', '0.2.0');
    expect(check).toEqual({
      ok: true,
      wouldBreak: [
        { id: breaks, name: 'Breaks', active: true, version: 2, reason: 'dropped' },
        { id: held, name: 'Held', active: true, version: 2, reason: 'behaviour' },
      ],
      needsReview: [{ id: wfReview.id, name: 'Review' }],
      unknown: false,
    });
    expect(fine).toBeTruthy();
    // Nothing was installed by looking.
    expect(t.deps.plugins.get('versioned')?.version).toBe('0.1.0');
  });

  it('updateCheck: a manifest without node versions is unknown; refusals are the ones update gives', async () => {
    const t = await installed();
    activeWorkflow(t, 'Breaks', 1);
    await serve('versioned2', '0.3.0');
    await refresh(t);
    expect(await t.deps.plugins.updateCheck('versioned', '0.3.0')).toEqual({
      ok: true,
      wouldBreak: [],
      needsReview: [],
      unknown: true,
    });
    expect(await t.deps.plugins.updateCheck('versioned', '0.1.0')).toEqual({
      ok: false,
      reason: 'versioned 0.1.0 is already installed',
    });
    expect(await t.deps.plugins.updateCheck('versioned', '9.9.9')).toEqual({
      ok: false,
      reason: 'versioned 9.9.9 is not in that catalog',
    });
    await expect(t.deps.plugins.updateCheck('nope', '1.0.0')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('updateCheck refuses a dev plugin', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('versioned')] } });
    await t.deps.plugins.start();
    expect(await t.deps.plugins.updateCheck('versioned', '0.2.0')).toMatchObject({ ok: false });
  });

  it('after the update the active version is NODE_OUTDATED (no upgrade path) and not runnable; the reviewable workflow got a migrated new version through the host and keeps its active pointer', async () => {
    const t = await installed();
    const breaks = activeWorkflow(t, 'Breaks', 1);
    const review = activeWorkflow(t, 'Review', 2, { mid: 'a' } as never);
    const r = await update(t, 'versioned', '0.2.0');
    if (!r.ok) throw new Error(r.reason);

    const loaded = t.deps.workflows.loadForRun(breaks, 2);
    expect(loaded.kind).toBe('invalid');
    expect(
      loaded.kind === 'invalid' && loaded.issues.filter((i) => i.severity === 'error'),
    ).toEqual([
      expect.objectContaining({
        code: 'NODE_OUTDATED',
        nodeId: 't',
        message: expect.stringContaining('no upgrade path'),
      }),
    ]);
    expect(t.deps.workflows.get(breaks)?.active).toMatchObject({ version: 2, runnable: false });
    // A workflow with no path is not rewritten.
    expect(t.deps.workflows.get(breaks)?.currentVersion).toBe(2);

    const detail = t.deps.workflows.get(review);
    expect(detail?.currentVersion).toBe(3);
    // 2→3 changes behavior: the active version is held, not run unreviewed.
    expect(detail?.active).toMatchObject({ version: 2, runnable: false });
    expect(detail?.activeIssues.map((i) => i.message)).toContain(
      'plugin update changes behavior of Thing; review and activate a new version',
    );
    expect(detail?.graph.nodes.find((n) => n.id === 't')).toMatchObject({
      typeVersion: 4,
      settings: { value: 'a' },
    });
    // No job runs it: a real queue is refused with the hold as the reason.
    const dir = await tempDir('plugin-held-');
    const root = join(dir, 'lib');
    await mkdir(root, { recursive: true });
    const file = join(root, 'a.mkv');
    await writeFile(file, 'x');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(file, old, old);
    const lib = await t.deps.engine.queue.createLibrary({
      name: 'TV',
      path: root,
    });
    if (!('id' in lib)) throw new Error('library not created');
    const refused = await t.deps.engine.queue.queue({
      path: file,
      workflowId: review,
      dryRun: false,
      force: true,
      priority: 0,
      createdBy: 'u',
    });
    expect(refused.kind).toBe('workflow-invalid');
    expect(
      refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.message).join(' '),
    ).toContain('plugin update changes behavior of Thing');
    await rm(dir, { recursive: true, force: true });
    expect(t.deps.workflows.versions(review)?.[0]).toMatchObject({
      createdBy: 'system:upgrade',
      note: expect.stringContaining('value is now required'),
    });
  });

  it('a workflow pinned to an older version is migrated at install and at start-up through the host, never refusing the plugin action', async () => {
    await serve('versioned');
    const t = setup();
    await t.deps.plugins.start();
    expect((await install(t, 'versioned')).ok).toBe(true);
    const wf = t.deps.workflows.create({ name: 'Old', kind: 'workflow' }, USER);
    t.deps.workflows.save({ id: wf.id, baseVersion: 1, graph: thingGraph(1, { old: 'a' }) }, USER);
    // Disable then enable: the upgrade runs once the plugin is back.
    await t.deps.plugins.disable('versioned');
    await t.deps.plugins.enable('versioned');
    const detail = t.deps.workflows.get(wf.id);
    expect(detail?.currentVersion).toBe(3);
    expect(detail?.graph.nodes.find((n) => n.id === 't')).toMatchObject({
      typeVersion: 3,
      settings: { value: 'a' },
    });
  });
});
