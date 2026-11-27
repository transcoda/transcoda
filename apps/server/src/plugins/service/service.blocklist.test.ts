import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../app/test-app.ts';
import { findPlugin } from '../../db/repos/plugins.ts';
import { OFFICIAL_BLOCKLIST_URL } from '../../platform/official-plugins.ts';
import { fixturePluginPath } from '../testing/build.ts';
import { BLOCKLIST_INERT_WARNING } from '../trust/official-keys.ts';

import {
  alive,
  base,
  blocklistServed,
  files,
  install,
  pidOf,
  serve,
  setup,
  sha,
  update,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

describe('blocklist', () => {
  const listed = (entries: unknown[]): string =>
    JSON.stringify({ schema: 1, generated: '2026-10-17T00:00:00.000Z', entries });
  const byName = (name: string) => ({
    id: 'bl-1',
    name,
    reason: 'test entry',
    url: 'https://example.com/advisory/1',
    added: '2026-10-17T00:00:00.000Z',
  });
  const bySha = (sha256: string) => ({
    id: 'bl-2',
    sha256,
    reason: 'test entry',
    url: null,
    added: '2026-10-17T00:00:00.000Z',
  });
  const recheck = (app: TestApp) => app.deps.plugins.recheckBlocklist();
  /**
   * start(), then wait for its background blocklist read. A forced refresh joins a read still in
   * flight, so a list written while the startup read runs would be missed by the next recheck.
   */
  const startSettled = async (app: TestApp): Promise<void> => {
    await app.deps.plugins.start();
    await recheck(app);
  };

  it('a listed sha256 stops the running plugin with the reason; plugins.changed is emitted and list() shows it', async () => {
    const entry = await serve('example');
    const t = setup();
    await startSettled(t);
    expect((await install(t, 'example')).ok).toBe(true);
    expect(t.deps.plugins.list()[0]?.blocked).toBeNull();
    const pid = pidOf(t, 'example');
    t.events.length = 0;

    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    await recheck(t);

    expect(t.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
      enabled: true,
    });
    expect(alive(pid)).toBe(false);
    expect(t.events).toContainEqual({
      type: 'plugins.changed',
      name: 'example',
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(t.deps.plugins.list()[0]?.blocked).toEqual({ reason: 'test entry', url: null });
    expect(t.deps.nodes.get('example:note')?.unavailable?.()).toBe(
      'plugin example is not running: blocklisted: test entry',
    );
    // Asking again changes nothing and publishes nothing.
    t.events.length = 0;
    await recheck(t);
    expect(t.events).toEqual([]);
  });

  it('catalog(refresh=true) also rechecks the blocklist: a running plugin newly listed is stopped at once', async () => {
    const entry = await serve('example');
    const t = setup();
    await startSettled(t);
    await install(t, 'example');
    const pid = pidOf(t, 'example');
    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    // catalog(false) fetches nothing new: the plugin keeps running.
    await t.deps.plugins.catalog(false);
    expect(t.deps.plugins.get('example')?.state).toBe('running');
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[0]?.plugins[0]?.versions[0]?.blocked).toEqual({
      reason: 'test entry',
      url: null,
    });
    expect(t.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(alive(pid)).toBe(false);
  });

  it('warns once at start when the official blocklist is configured with other catalog keys', async () => {
    const lines: unknown[] = [];
    const t = setup({
      blocklistUrl: OFFICIAL_BLOCKLIST_URL,
      catalogKeys: [{ id: 'mine', publicKey: 'a'.repeat(64) }],
      log: { info: () => {}, warn: (m) => lines.push(m), error: () => {} },
    });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    try {
      await t.deps.plugins.start();
      await t.deps.plugins.stop();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(lines.filter((m) => String(m).includes('blocklist is inert'))).toEqual([
      BLOCKLIST_INERT_WARNING,
    ]);
  });

  it('enable and restart stay refused by the verify seam while the build is listed; removing the entry lets a restart through', async () => {
    const entry = await serve('example');
    const t = setup();
    await startSettled(t);
    await install(t, 'example');
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await recheck(t);
    await expect(t.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
    expect(findPlugin(t.db, 'example')?.sha256).toBe(sha(entry.bundle));
    await writeFile(t.blocklistFile, listed([]));
    await recheck(t);
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({ state: 'running' });
    expect(t.deps.plugins.list()[0]?.blocked).toBeNull();
  });

  it('install of a listed name is refused before anything is downloaded: no files, no row, no nodes', async () => {
    await serve('example');
    const t = setup();
    // Listed before start, then loaded: install checks the list in memory, and the startup
    // read runs in the background (a write after start() could land after that read).
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await t.deps.plugins.start();
    await t.deps.plugins.recheckBlocklist();
    const result = await install(t, 'example');
    expect(result).toEqual({ ok: false, reason: 'blocklisted: test entry' });
    expect(await files(t)).toEqual([]);
    expect(findPlugin(t.db, 'example')).toBeNull();
    expect(t.deps.nodes.get('example:note')).toBeUndefined();
  });

  it('a version range blocks only the builds inside it, at install and at update', async () => {
    await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    // Listed before start, then loaded (see "install of a listed name").
    await writeFile(
      t.blocklistFile,
      listed([{ ...byName('example'), versions: '>=0.2.0 <1.0.0' }]),
    );
    await t.deps.plugins.start();
    await t.deps.plugins.recheckBlocklist();
    expect((await install(t, 'example', '0.1.0')).ok).toBe(true);
    expect(await update(t, 'example', '0.2.0')).toEqual({
      ok: false,
      reason: 'blocklisted: test entry',
    });
    expect(t.deps.plugins.get('example')).toMatchObject({ version: '0.1.0', state: 'running' });
    expect(await files(t)).toEqual(['example-0.1.0.js', 'example-0.1.0.manifest.json']);
  });

  it('the catalog answer marks blocked versions and carries the blocklist status', async () => {
    const entry = await serve('example');
    await serve('example', '0.2.0');
    const t = setup();
    await startSettled(t);
    await writeFile(t.blocklistFile, listed([bySha(sha(entry.bundle))]));
    const out = await t.deps.plugins.catalog(true);
    const versions = out.catalogs[0]?.plugins[0]?.versions ?? [];
    expect(versions.map((v) => [v.version, v.blocked])).toEqual([
      ['0.1.0', { reason: 'test entry', url: null }],
      ['0.2.0', null],
    ]);
    expect(out.blocklist).toEqual({
      url: t.deps.config.pluginBlocklistUrl,
      error: null,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      entries: 1,
    });
  });

  it('a disabled plugin stays disabled when it is listed; enable is then refused', async () => {
    await serve('example');
    const t = setup();
    await startSettled(t);
    await install(t, 'example');
    await t.deps.plugins.disable('example');
    t.events.length = 0;
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await recheck(t);
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'disabled', enabled: false });
    expect(t.events).toEqual([]);
    expect(t.deps.plugins.list()[0]?.blocked?.reason).toBe('test entry');
    await expect(t.deps.plugins.enable('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
  });

  it('the cached list is enforced at the next start, before the plugins boot, even with no network', async () => {
    await serve('example');
    const first = setup({ blocklistUrl: `${base}/blocklist.json` });
    blocklistServed.body = listed([]);
    await startSettled(first);
    await install(first, 'example');
    blocklistServed.body = listed([byName('example')]);
    await first.deps.plugins.catalog(true);
    expect(first.deps.plugins.list()[0]?.blocked?.reason).toBe('test entry');
    await first.deps.plugins.stop();

    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      blocklistUrl: 'http://127.0.0.1:1/blocklist.json',
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'blocklisted: test entry',
    });
  });

  it('fail-open: an unreachable blocklist does not stop an install, and start() does not wait for it', async () => {
    await serve('example');
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    try {
      const t = setup({
        blocklistUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/blocklist.json`,
      });
      const began = Date.now();
      await t.deps.plugins.start();
      expect(Date.now() - began).toBeLessThan(1500);
      const result = await install(t, 'example');
      expect(result.ok).toBe(true);
      expect(t.deps.plugins.list()[0]).toMatchObject({ state: 'running', blocked: null });
      expect((await t.deps.plugins.catalog(false)).blocklist).toMatchObject({
        entries: 0,
        fetchedAt: null,
      });
      expect((await t.deps.plugins.catalog(false)).blocklist.error).toMatch(
        /^blocklist fetch failed: /,
      );
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  }, 30_000);

  it('a dev plugin is never blocked by the list', async () => {
    const t = setup({ plugins: { devPlugins: [fixturePluginPath('example')] } });
    await writeFile(t.blocklistFile, listed([byName('example')]));
    await t.deps.plugins.start();
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running', blocked: null });
    await recheck(t);
    expect(t.deps.plugins.get('example')).toMatchObject({ state: 'running', blocked: null });
  });
});
