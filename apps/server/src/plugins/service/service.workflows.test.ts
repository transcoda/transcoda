import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../engine/testing/fixtures.ts';
import { chain, node } from '../../workflows/testing.ts';

import { files, install, serve, setup, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('workflows that use a plugin', () => {
  it('[activation] usage() lists a workflow whose active version uses the node with active: true; after disable the workflow is active and not runnable, a real jobs.queue is WORKFLOW_INVALID, remove() still succeeds and the node is UNKNOWN_NODE_TYPE', async () => {
    await serve('example');
    const dir = await tempDir('plugin-usage-');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    expect(t.deps.plugins.usage('example')).toEqual([]);

    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
      node('pn', 'example:note', {}),
    );
    const wf = t.deps.workflows.create({ name: 'Notes', kind: 'workflow', graph }, 'u');
    const detail = t.deps.workflows.get(wf.id);
    expect(detail?.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: false }]);
    expect(t.deps.workflows.activate(wf.id, 1, 'u').kind).toBe('ok');
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: true }]);
    expect(t.deps.plugins.get('example')?.usedBy).toEqual([
      { id: wf.id, name: 'Notes', active: true },
    ]);

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
    const queueReal = () =>
      t.deps.engine.queue.queue({
        path: file,
        workflowId: wf.id,
        dryRun: false,
        force: true,
        priority: 0,
        createdBy: 'u',
      });
    expect((await queueReal()).kind).toBe('queued');

    await t.deps.plugins.disable('example');
    const summary = t.deps.workflows.list().find((w) => w.id === wf.id);
    expect(summary?.active).toMatchObject({ version: 1, runnable: false });
    expect(t.deps.workflows.get(wf.id)?.activeIssues).toEqual([
      expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE', nodeId: 'pn' }),
    ]);
    const refused = await queueReal();
    expect(refused).toMatchObject({ kind: 'workflow-invalid' });
    expect(refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.code)).toContain(
      'PLUGIN_UNAVAILABLE',
    );
    expect(
      refused.kind === 'workflow-invalid' && refused.issues.map((i) => i.message).join(' '),
    ).toContain('plugin example is disabled');
    // The workflow is still listed as using the plugin.
    expect(t.deps.plugins.usage('example')).toEqual([{ id: wf.id, name: 'Notes', active: true }]);

    await t.deps.plugins.remove('example');
    // A removal is announced as disabled/removed (the state enum has no `removed`).
    expect(t.events.at(-1)).toEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'disabled',
      stateReason: 'removed',
    });
    expect(t.deps.plugins.get('example')).toBeNull();
    expect(await files(t)).toEqual([]);
    expect(t.deps.nodes.get('example:note')).toBeUndefined();
    const loaded = t.deps.workflows.loadForRun(wf.id, 1);
    expect(loaded.kind).toBe('invalid');
    expect(loaded.kind === 'invalid' && loaded.issues.map((i) => i.code)).toContain(
      'UNKNOWN_NODE_TYPE',
    );
    expect(await queueReal()).toMatchObject({ kind: 'workflow-invalid' });
    await rm(dir, { recursive: true, force: true });
  });

  it('usage() is [] before start() and never throws', async () => {
    const t = setup();
    expect(t.deps.plugins.usage('example')).toEqual([]);
    expect(t.deps.plugins.usage('nope')).toEqual([]);
    expect(t.deps.plugins.list()).toEqual([]);
    expect(t.deps.plugins.missing()).toEqual([]);
  });
});
