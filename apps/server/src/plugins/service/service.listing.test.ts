import { describe, expect, it } from 'vitest';
import { chain, node } from '../../workflows/testing.ts';

import { base, install, serve, setup, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('what the Plugins page shows', () => {
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="4"/></svg>';

  it('list() carries the manifest icon, the workflows using the plugin and the last test without its message', async () => {
    await serve('example', '0.1.0', { manifest: { icon: ICON } });
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    await install(t, 'secrets');
    const graph = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('ro', 'core:replace-original'),
      node('pn', 'example:note', {}),
    );
    const wf = t.deps.workflows.create({ name: 'Notes', kind: 'workflow', graph }, 'u');
    const byName = () => new Map(t.deps.plugins.list().map((p) => [p.name, p]));
    expect(byName().get('example')).toMatchObject({
      icon: ICON,
      usedBy: [{ id: wf.id, name: 'Notes', active: false }],
      lastTest: null,
    });
    expect(byName().get('secrets')).toMatchObject({ icon: null, usedBy: [], lastTest: null });

    await t.deps.plugins.saveSettings('secrets', { apiKey: 'A-KEY-THAT-IS-LONG-1' });
    await t.deps.plugins.testSettings('secrets', { apiKey: { set: true } });
    const tested = byName().get('secrets')?.lastTest;
    expect(tested).toEqual({ at: expect.any(String), ok: true, kind: null });
    await t.deps.plugins.testSettings('secrets', { apiKey: '' });
    expect(byName().get('secrets')?.lastTest).toMatchObject({ ok: false, kind: 'other' });
    expect(JSON.stringify(t.deps.plugins.list())).not.toContain('A-KEY-THAT-IS-LONG-1');
  });

  it('missing() names the plugins whose nodes workflows use but that are not installed, with those workflows', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const uses = (name: string, ...types: string[]) =>
      t.deps.workflows.create(
        {
          name,
          kind: 'workflow',
          graph: chain(
            'workflow',
            node('in', 'core:input-manual'),
            ...types.map((type, i) => node(`n${i}`, type, {})),
          ),
        },
        'u',
      );
    const tv = uses('TV cleanup', 'sonarr:original-language', 'jellyfin:refresh');
    const movies = uses('Movies', 'jellyfin:refresh', 'example:note');
    uses('Plain', 'core:replace-original');
    // A node type whose prefix is no plugin name names nothing to install (and would break the list).
    uses('Odd', '0x:y', '-a:b', `${'a'.repeat(41)}:c`);
    expect(t.deps.plugins.missing()).toEqual([
      { name: 'example', workflows: [{ id: movies.id, name: 'Movies' }] },
      {
        name: 'jellyfin',
        workflows: [
          { id: movies.id, name: 'Movies' },
          { id: tv.id, name: 'TV cleanup' },
        ],
      },
      { name: 'sonarr', workflows: [{ id: tv.id, name: 'TV cleanup' }] },
    ]);
    await install(t, 'example');
    expect(t.deps.plugins.missing().map((m) => m.name)).toEqual(['jellyfin', 'sonarr']);
    // The list answers both from one pass over the workflows.
    expect(t.deps.plugins.listing()).toEqual({
      plugins: t.deps.plugins.list(),
      missing: t.deps.plugins.missing(),
    });
    expect(t.deps.plugins.listing().plugins[0]?.usedBy).toEqual([
      { id: movies.id, name: 'Movies', active: false },
    ]);
  });

  it("a custom catalog's manifests are fetched only on an explicit refresh; the official one's as it is read", async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(`${base}/custom.json`);
    const nodesBy = (out: Awaited<ReturnType<typeof t.deps.plugins.catalog>>) =>
      out.catalogs.map((c) => [c.official, c.plugins[0]?.nodes.length ?? 0]);
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 0],
    ]);
    expect(nodesBy(await t.deps.plugins.catalog(true))).toEqual([
      [true, 3],
      [false, 3],
    ]);
    // Kept while the catalog lists the build, and dropped with the catalog.
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 3],
    ]);
    t.deps.plugins.removeCatalog(`${base}/custom.json`);
    expect((await t.deps.plugins.catalog(false)).catalogs).toHaveLength(1);
    t.deps.plugins.addCatalog(`${base}/custom.json`);
    expect(nodesBy(await t.deps.plugins.catalog(false))).toEqual([
      [true, 3],
      [false, 0],
    ]);
  });

  it("catalog entries carry the latest version's icon and nodes from its manifest; kind and title come from the manifest, else from the installed plugin, else are null", async () => {
    await serve('example', '0.1.0');
    await serve('secrets', '0.1.0', {
      manifest: {
        icon: ICON,
        nodes: ['secrets:peek'],
        nodeInfo: [{ type: 'secrets:peek', kind: 'data', title: 'Peek' }],
      },
    });
    const t = setup();
    await t.deps.plugins.start();
    const entries = async () =>
      new Map((await t.deps.plugins.catalog(true)).catalogs[0]?.plugins.map((p) => [p.name, p]));
    const before = await entries();
    expect(before.get('secrets')).toMatchObject({
      icon: ICON,
      nodes: [{ type: 'secrets:peek', kind: 'data', title: 'Peek' }],
    });
    expect(before.get('example')).toMatchObject({
      icon: null,
      nodes: [
        { type: 'example:extension-is', kind: null, title: null },
        { type: 'example:note', kind: null, title: null },
        { type: 'example:fixed-language', kind: null, title: null },
      ],
    });
    await install(t, 'example');
    expect((await entries()).get('example')?.nodes).toEqual([
      { type: 'example:extension-is', kind: 'condition', title: 'Extension is' },
      { type: 'example:note', kind: 'finish', title: 'Note' },
      { type: 'example:fixed-language', kind: 'data', title: 'Fixed language' },
    ]);
  });

  it("lists each version's network hosts, and the installed build's; an install whose catalog, manifest or bundle disagree on them is refused", async () => {
    const real = [{ origin: 'https://api.example.test' }];
    await serve('leaky');
    const t = setup();
    await t.deps.plugins.start();
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]?.plugins[0]?.versions[0]?.network).toEqual(real);
    expect(await install(t, 'leaky')).toMatchObject({ ok: true });
    // The installed plugin carries its manifest's hosts, for its row on the Plugins page.
    expect(t.deps.plugins.list().find((p) => p.name === 'leaky')?.network).toEqual(real);
    await t.deps.plugins.remove('leaky');

    const other = [{ origin: 'https://other.example.test' }];
    await serve('leaky', '0.1.0', { indexNetwork: other });
    expect(await install(t, 'leaky')).toEqual({
      ok: false,
      reason: 'the manifest lists other network hosts than the catalog entry',
    });
    await serve('leaky', '0.1.0', { manifest: { network: other } });
    expect(await install(t, 'leaky')).toEqual({
      ok: false,
      reason: "the bundle's own manifest differs from the catalog entry in: network",
    });
    // A build listed before SDK 1.3.0 carries no list and still installs.
    await serve('leaky', '0.1.0', { manifest: { network: undefined }, indexNetwork: null });
    expect((await t.deps.plugins.catalog(true)).catalogs[0]?.plugins[0]?.versions[0]?.network).toBe(
      null,
    );
    expect(await install(t, 'leaky')).toMatchObject({ ok: true });
    expect(t.deps.plugins.list().find((p) => p.name === 'leaky')?.network).toBeNull();
  });

  it('a catalog entry whose manifest cannot be read has no icon and no nodes, and the catalog still answers', async () => {
    // A manifest for another plugin is refused, as the installer refuses it.
    await serve('example', '0.1.0', { manifest: { name: 'other', icon: ICON } });
    const t = setup();
    await t.deps.plugins.start();
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]?.error).toBeNull();
    expect(out.catalogs[0]?.plugins[0]).toMatchObject({ name: 'example', icon: null, nodes: [] });
  });
});
