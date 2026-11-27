import { describe, expect, it } from 'vitest';
import { findPlugin } from '../../db/repos/plugins.ts';
import { fixturePluginPath } from '../testing/build.ts';

import { files, indexUrl, install, serve, setup, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('dev plugins', () => {
  it('load from TRANSCODA_DEV_PLUGINS, are never persisted and are listed with catalogUrl null', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    expect(t.deps.plugins.list()).toEqual([
      expect.objectContaining({
        name: 'example',
        version: '0.1.0',
        catalogUrl: null,
        state: 'running',
        enabled: true,
        nodes: ['example:extension-is', 'example:note', 'example:fixed-language'],
      }),
    ]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(await files(t)).toEqual([]);
    expect(t.deps.nodes.get('example:note')?.source).toMatchObject({
      kind: 'plugin',
      name: 'example',
    });
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBeNull();
    // Not in the catalog operations either: an install of the same name is refused.
    await serve('example');
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'plugin example is already installed',
    });
  });

  it('a dev bundle that shadows an installed plugin is refused with a log line, not loaded', async () => {
    await serve('example');
    const first = setup();
    await first.deps.plugins.start();
    await install(first, 'example');
    await first.deps.plugins.stop();
    const errors: unknown[] = [];
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      plugins: { devPlugins: [fixturePluginPath('example')] },
      log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    });
    await second.deps.plugins.start();
    expect(errors).toContainEqual(
      expect.objectContaining({
        msg: 'dev plugin not loaded',
        reason: 'dev plugin example shadows the installed one; remove it first',
      }),
    );
    expect(second.deps.plugins.get('example')).toMatchObject({ catalogUrl: indexUrl });
  });
});
