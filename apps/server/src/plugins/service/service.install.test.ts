import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPlugin } from '../../db/repos/plugins.ts';
import { createCoreRegistry } from '../../nodes/registry.ts';

import { files, indexUrl, install, serve, served, setup, text, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('install', () => {
  it('installs example from the catalog: files written, row enabled, nodes registered, state running, plugins.changed emitted, nodes.list shows source plugin', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);

    expect(result.plugin).toMatchObject({
      name: 'example',
      version: '0.1.0',
      enabled: true,
      state: 'running',
      stateReason: null,
      hasIntegration: false,
      catalogUrl: indexUrl,
      nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
      provenance: { coreTested: ['1.0.0'], attestation: null },
    });
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
    const row = findPlugin(t.db, 'example');
    expect(row).toMatchObject({ enabled: true, version: '0.1.0', catalogUrl: indexUrl });
    expect(row?.nodes.map((n) => n.type)).toEqual(result.plugin.nodes);
    expect(t.events).toContainEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'running',
      stateReason: null,
    });
    const listed = t.deps.workflows.listNodes().find((n) => n.type === 'example:note');
    expect(listed).toMatchObject({ source: { kind: 'plugin', name: 'example', version: '0.1.0' } });
    expect(listed?.availability).toEqual({ available: true });
    expect(t.deps.plugins.list().map((p) => [p.name, p.state])).toEqual([['example', 'running']]);
    expect(t.deps.plugins.get('nope')).toBeNull();
  });

  it('refuses: checksum mismatch, sdk ^2, manifest name/version mismatch, crash on start, a bundle with no plugin export — each with the exact reason, no files, no row, no nodes', async () => {
    const t = setup();
    await t.deps.plugins.start();
    const nodesBefore = t.deps.nodes.list().length;
    const clean = async (name: string) => {
      expect(await files(t), name).toEqual([]);
      expect(findPlugin(t.db, name)).toBeNull();
      expect(t.deps.plugins.list()).toEqual([]);
      expect(t.deps.nodes.list()).toHaveLength(nodesBefore);
    };

    await serve('example', '0.1.0', { sha256: 'a'.repeat(64) });
    expect(await install(t, 'example')).toEqual({ ok: false, reason: 'checksum mismatch' });
    await clean('example');

    await serve('example', '0.1.0', { manifest: { sdk: '^2' }, indexSdk: '^1' });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'sdk ^2 is not supported by this server (sdk 1.3.0)',
    });
    await serve('example', '0.1.0', { indexSdk: '^2' });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'sdk ^2 is not supported by this server (sdk 1.3.0)',
    });
    await clean('example');

    await serve('example', '0.1.0', {
      edit: (c) => c.replace('version: "0.1.0"', 'version: "0.9.0"'),
    });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'manifest in bundle says example 0.9.0, catalog says 0.1.0',
    });
    await clean('example');

    await serve('example', '0.1.0', {
      edit: (c) => c.replace('await ctx.log("debug", "example 0.1.0 loaded");', 'process.exit(3);'),
    });
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: exited with code 3',
    });
    await clean('example');

    // Review focus 1: valid JavaScript without a definePlugin default export.
    served.set('badexport-0.1.0', {
      name: 'badexport',
      version: '0.1.0',
      bundle: text('badexport'),
      manifest: {
        name: 'badexport',
        version: '0.1.0',
        sdk: '^1',
        nodes: [],
        integration: null,
        triggers: [],
        hooks: [],
      },
    });
    expect(await install(t, 'badexport')).toEqual({
      ok: false,
      reason: 'plugin crashed on start: crashed: bundle has no plugin default export',
    });
    await clean('badexport');

    expect(await install(t, 'example', '9.9.9')).toEqual({
      ok: false,
      reason: 'example 9.9.9 is not in that catalog',
    });
    expect(
      await t.deps.plugins.install({
        name: 'example',
        version: '0.1.0',
        catalogUrl: 'https://x.test/i.json',
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a bundle whose node type collides with core and rolls back', async () => {
    await serve('example');
    const core = createCoreRegistry().list();
    const stand = core[0];
    if (!stand) throw new Error('no core node');
    const t = setup({
      nodes: [...core, { def: { ...stand.def, type: 'example:note' }, source: { kind: 'core' } }],
    });
    await t.deps.plugins.start();
    const before = t.deps.nodes.list().length;
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'node type example:note is already provided by core',
    });
    expect(await files(t)).toEqual([]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(t.deps.nodes.list()).toHaveLength(before);
    expect(t.deps.nodes.get('example:note')?.source).toEqual({ kind: 'core' });
    expect(t.deps.plugins.list()).toEqual([]);
  });

  it('refuses a second install of the same name and clears files a crash left behind', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    // A leftover with no row (the process died between the rename and the insert).
    await mkdir(t.deps.config.pluginsDir, { recursive: true });
    await writeFile(join(t.deps.config.pluginsDir, 'example-0.1.0.js'), 'stale');
    expect((await install(t, 'example')).ok).toBe(true);
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin example is already installed',
    });
  });
});
