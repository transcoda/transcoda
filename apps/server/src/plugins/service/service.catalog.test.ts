import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../app/testing/app.ts';
import { fixturePluginPath } from '../testing/build.ts';
import { UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_MS } from './service.ts';

import {
  apps,
  base,
  indexServed,
  indexUrl,
  install,
  refresh,
  serve,
  served,
  setup,
  update,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

describe('catalog', () => {
  it('an official catalog with an empty key list refuses an unsigned index with "catalog signature missing"', async () => {
    await serve('example');
    const t = createTestApp({
      log: { info: () => {}, warn: () => {}, error: () => {} },
      config: { pluginCatalogUrl: indexUrl, pluginCatalogKeys: [] },
    });
    apps.push(t);
    await t.deps.plugins.start();
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]).toMatchObject({
      catalogUrl: indexUrl,
      official: true,
      error: 'catalog signature missing',
      plugins: [],
    });
  });

  it('lists the catalogs with installed and update-available marks; custom catalogs can be added and removed, the official one cannot', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs).toHaveLength(1);
    const c = out.catalogs[0];
    expect(c).toMatchObject({ catalogUrl: indexUrl, official: true, error: null });
    expect(c?.plugins[0]).toMatchObject({
      name: 'example',
      latest: '0.2.0',
      installed: '0.1.0',
      versions: [
        expect.objectContaining({
          version: '0.1.0',
          compatible: true,
          sdk: '^1',
          coreTested: ['1.0.0'],
        }),
        expect.objectContaining({ version: '0.2.0' }),
      ],
    });
    expect(t.deps.plugins.get('example')?.updateAvailable).toBe('0.2.0');

    const other = `${base}/index.json?other=1`;
    t.deps.plugins.addCatalog(other);
    expect(
      (await t.deps.plugins.catalog(false)).catalogs.map((x) => [
        x.catalogUrl === other,
        x.official,
      ]),
    ).toEqual([
      [false, true],
      [true, false],
    ]);
    t.deps.plugins.removeCatalog(other);
    expect((await t.deps.plugins.catalog(false)).catalogs).toHaveLength(1);
    expect(() => t.deps.plugins.removeCatalog(indexUrl)).toThrow(
      /official catalog cannot be removed/,
    );
    expect(() => t.deps.plugins.addCatalog('ftp://x.test/i.json')).toThrow(/https/);
    expect(() => t.deps.plugins.addCatalog('not a url')).toThrow(/not a url/);
    // Updating clears the mark.
    await update(t, 'example', '0.2.0');
    expect(t.deps.plugins.get('example')?.updateAvailable).toBeNull();
  });

  it('an unreachable catalog is an error line on that catalog, not a failure', async () => {
    const t = setup();
    t.deps.plugins.addCatalog('http://127.0.0.1:1/index.json');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs.find((x) => !x.official)?.error).toMatch(/catalog fetch failed/);
    expect(out.catalogs.find((x) => x.official)?.error).toBeNull();
  });
});

describe('background update check', () => {
  const updatesChanged = (t: { events: Record<string, unknown>[] }, name: string) =>
    t.events.filter((e) => e.type === 'plugins.changed' && e.name === name);

  it('finds an update without the catalog being opened and publishes plugins.changed once', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    expect(t.deps.plugins.get('example')?.updateAvailable).toBeNull();
    await serve('example', '0.2.0');
    t.events.length = 0;

    await t.deps.plugins.checkUpdates();
    expect(t.deps.plugins.get('example')?.updateAvailable).toBe('0.2.0');
    expect(updatesChanged(t, 'example')).toEqual([
      { type: 'plugins.changed', name: 'example', state: 'running', stateReason: null },
    ]);
    // Nothing new: nothing published.
    t.events.length = 0;
    await t.deps.plugins.checkUpdates();
    expect(t.events).toEqual([]);
    // The catalog page's fetch publishes a change too (the menu badge follows).
    served.delete('example-0.2.0');
    await refresh(t);
    expect(t.deps.plugins.get('example')?.updateAvailable).toBeNull();
    expect(updatesChanged(t, 'example')).toHaveLength(1);
  });

  it('a catalog that cannot be read keeps the updates last known and only warns', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const warnings: unknown[] = [];
    const t = setup({ log: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} } });
    await t.deps.plugins.start();
    await install(t, 'example');
    await t.deps.plugins.checkUpdates();
    expect(t.deps.plugins.get('example')?.updateAvailable).toBe('0.2.0');
    t.events.length = 0;

    // Unreachable, and no cached index to fall back on.
    indexServed.down = true;
    await rm(join(t.deps.config.pluginsDir, '.catalog'), { recursive: true, force: true });
    await t.deps.plugins.checkUpdates();
    expect(t.deps.plugins.get('example')?.updateAvailable).toBe('0.2.0');
    expect(t.events).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ msg: 'plugin update check', catalog: indexUrl }),
    );
  });

  it('a dev plugin never has an update', async () => {
    await serve('example', '0.2.0');
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await t.deps.plugins.start();
    await t.deps.plugins.checkUpdates();
    expect(t.deps.plugins.get('example')?.updateAvailable).toBeNull();
  });

  it('runs shortly after start, then every 6 hours, and stops on shutdown', async () => {
    const t = setup();
    const check = vi.spyOn(t.deps.plugins, 'checkUpdates').mockResolvedValue();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await t.deps.plugins.start();
      expect(check).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
      expect(check).toHaveBeenCalledTimes(2);
      await t.deps.plugins.stop();
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
