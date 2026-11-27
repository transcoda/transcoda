import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fakeHookContext } from '@transcoda/sdk/testing';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../app/testing/app.ts';
import { findPluginSettings } from '../../db/repos/plugins.ts';
import { tempDir } from '../../engine/testing/fixtures.ts';
import { PluginServiceError } from './service.ts';

import { install, serve, setup, update, useTestCatalog } from './testing.ts';

useTestCatalog();

describe('settings', () => {
  const KEY = 'S3CRET-API-KEY-1';

  async function withSecrets() {
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    const r = await install(t, 'secrets');
    if (!r.ok) throw new Error(r.reason);
    return t;
  }

  const encOf = (t: TestApp): string =>
    ((findPluginSettings(t.db, 'secrets')?.settings ?? {}) as { apiKey?: { $enc: string } }).apiKey
      ?.$enc ?? '';

  const storedJson = (t: TestApp): string =>
    JSON.stringify(findPluginSettings(t.db, 'secrets')?.settings ?? null);

  it('a token-like stored secret of 20 characters or more is shown by its last four; a shorter one or a passphrase only as set', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'abcdef0123456789f2a4' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({
      apiKey: { set: true, endsWith: 'f2a4' },
    });
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'SHORT-KEY-1234567xy' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({ apiKey: { set: true } });
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'correct horse battery staple' });
    expect(t.deps.plugins.getSettings('secrets').settings).toEqual({ apiKey: { set: true } });
    expect(JSON.stringify(t.deps.plugins.getSettings('secrets'))).not.toContain('aple');
    expect(JSON.stringify(t.deps.plugins.getSettings('secrets'))).not.toContain('SHORT');
  });

  it('save encrypts secrets (the row never contains the plaintext), get masks them as { set: true }, a save with { set: true } keeps the old value', async () => {
    const t = await withSecrets();
    expect(t.deps.plugins.getSettings('secrets')).toEqual({
      settings: {},
      lastTest: null,
      needsReview: null,
    });
    const saved = await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    expect(saved).toEqual({
      settings: { apiKey: { set: true } },
      lastTest: null,
      needsReview: null,
    });

    const raw = storedJson(t);
    expect(raw).not.toContain(KEY);
    const stored = findPluginSettings(t.db, 'secrets')?.settings as { apiKey: { $enc: string } };
    expect(typeof stored.apiKey.$enc).toBe('string');
    // No row in the whole database carries the plaintext.
    const dump = JSON.stringify(t.db.prepare('SELECT * FROM plugin_settings').all());
    expect(dump).not.toContain(KEY);
    // Nothing the service answers carries it either.
    expect(JSON.stringify(t.deps.plugins.get('secrets'))).not.toContain(KEY);
    expect(JSON.stringify(t.deps.plugins.list())).not.toContain(KEY);

    const before = stored.apiKey.$enc;
    await t.deps.plugins.saveSettings('secrets', { apiKey: { set: true } });
    expect(encOf(t)).toBe(before);
    await t.deps.plugins.saveSettings('secrets', {});
    expect(encOf(t)).toBe(before);
    // A new value replaces it.
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'ANOTHER-KEY-22' });
    expect(encOf(t)).not.toBe(before);
  });

  it("an invalid save is refused with the plugin's own issues and stores nothing", async () => {
    const t = await withSecrets();
    const err = (await t.deps.plugins
      .saveSettings('secrets', { apiKey: '' })
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(err).toBeInstanceOf(PluginServiceError);
    expect(err.code).toBe('settings-invalid');
    expect(err.issues).toEqual([expect.objectContaining({ path: 'apiKey' })]);
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();
    const notObject = (await t.deps.plugins
      .saveSettings('secrets', 'x')
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(notObject.code).toBe('settings-invalid');
    const encrypted = (await t.deps.plugins
      .saveSettings('secrets', { apiKey: { $enc: 'AAAA' } })
      .catch((e: unknown) => e)) as PluginServiceError;
    expect(encrypted.code).toBe('settings-invalid');
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();
  });

  it('test() runs on unsaved values and persists nothing but lastTest; the plugin process received the opened settings (its answer references them redacted)', async () => {
    const t = await withSecrets();
    // Nothing saved yet: the test runs on the form's values, and there is no row to note it on.
    const first = await t.deps.plugins.testSettings('secrets', { apiKey: 'UNSAVED-KEY-77' });
    expect(first).toEqual({ ok: true, message: 'key is [redacted]' });
    expect(findPluginSettings(t.db, 'secrets')).toBeNull();

    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    const rowBefore = storedJson(t);
    const viaStored = await t.deps.plugins.testSettings('secrets', { apiKey: { set: true } });
    expect(viaStored).toEqual({ ok: true, message: 'key is [redacted]' });
    const candidate = await t.deps.plugins.testSettings('secrets', { apiKey: 'CANDIDATE-KEY-9' });
    expect(candidate).toEqual({ ok: true, message: 'key is [redacted]' });
    expect(storedJson(t)).toBe(rowBefore);
    const row = findPluginSettings(t.db, 'secrets');
    expect(row?.lastTest).toMatchObject({ ok: true, message: 'key is [redacted]' });
    const got = t.deps.plugins.getSettings('secrets');
    expect(got.lastTest).toMatchObject({ result: { ok: true, message: 'key is [redacted]' } });
    const everything = JSON.stringify([first, viaStored, candidate, row, got]);
    for (const secret of [KEY, 'UNSAVED-KEY-77', 'CANDIDATE-KEY-9']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('a failing test() is stored without a secret in its message', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    // The plugin's schema refuses an empty key: the host's complaint is the message.
    const out = await t.deps.plugins.testSettings('secrets', { apiKey: '' });
    expect(out).toMatchObject({ ok: false, kind: 'other' });
    const saved = findPluginSettings(t.db, 'secrets')?.lastTest;
    expect(saved).toMatchObject({ ok: false, kind: 'other' });
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });

  it('settings of a plugin without an integration, and of a stopped plugin, answer with errors', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'example');
    expect(() => t.deps.plugins.getSettings('example')).toThrow(/has no settings/);
    expect(() => t.deps.plugins.getSettings('ghost')).toThrow(/not installed/);

    await serve('secrets');
    await install(t, 'secrets');
    await t.deps.plugins.disable('secrets');
    await expect(
      t.deps.plugins.testSettings('secrets', { apiKey: 'x-key-1' }),
    ).rejects.toMatchObject({
      code: 'not-running',
    });
    // A save still works while it is down, validated against the stored schema.
    await expect(t.deps.plugins.saveSettings('secrets', { apiKey: '' })).rejects.toMatchObject({
      code: 'settings-invalid',
    });
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    expect(storedJson(t)).not.toContain(KEY);
  });

  it('Review focus 5: settings needsReview when the stored shape no longer parses after an update; the old encrypted value stays, get still answers, the process keeps running', async () => {
    await serve('secrets');
    const t = setup();
    await t.deps.plugins.start();
    await install(t, 'secrets');
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    const stored = storedJson(t);

    // 0.2.0 renames the field.
    await serve('secrets', '0.2.0', { edit: (c) => c.replaceAll('apiKey', 'token') });
    const updated = await update(t, 'secrets', '0.2.0');
    if (!updated.ok) throw new Error(updated.reason);
    expect(updated.plugin).toMatchObject({ version: '0.2.0', state: 'running' });

    const got = t.deps.plugins.getSettings('secrets');
    expect(got.settings).toEqual({ apiKey: { set: true } });
    expect(got.needsReview).toMatch(/needs review: token:/);
    expect(JSON.stringify(got)).not.toContain(KEY);
    expect(storedJson(t)).toBe(stored);

    // Saving the new shape replaces it and clears the review.
    const saved = await t.deps.plugins.saveSettings('secrets', { token: 'NEW-TOKEN-55' });
    expect(saved).toMatchObject({ settings: { token: { set: true } }, needsReview: null });
    expect(storedJson(t)).not.toContain('NEW-TOKEN-55');
    expect(await t.deps.plugins.testSettings('secrets', { token: { set: true } })).toMatchObject({
      ok: true,
      message: 'key is [redacted]',
    });
  });

  it('settings that cannot be decrypted (the secret key changed) say so and start the plugin without them', async () => {
    const t = await withSecrets();
    await t.deps.plugins.saveSettings('secrets', { apiKey: KEY });
    await t.deps.plugins.stop();
    const warn: unknown[] = [];
    const other = setup({
      db: t.db,
      pluginsDir: t.deps.config.pluginsDir,
      log: { info: () => {}, warn: (m) => warn.push(m), error: () => {} },
    });
    // The stored value no longer opens (a different secret key, or a damaged row).
    t.db
      .prepare('UPDATE plugin_settings SET settings_json = ? WHERE plugin_name = ?')
      .run(
        JSON.stringify({ apiKey: { $enc: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }),
        'secrets',
      );
    await other.deps.plugins.start();
    expect(other.deps.plugins.get('secrets')?.state).toBe('running');
    expect(other.deps.plugins.getSettings('secrets').needsReview).toBe(
      'cannot decrypt secrets.apiKey',
    );
    expect(JSON.stringify(warn)).not.toContain(KEY);
  });

  it('testMapping: local must exist, be a directory and lie under a library root', async () => {
    await serve('example');
    const dir = await tempDir('plugin-map-');
    await mkdir(join(dir, 'lib', 'tv'), { recursive: true });
    await writeFile(join(dir, 'lib', 'file.txt'), 'x');
    const t = setup({ libraryRoots: () => [join(dir, 'lib')] });
    await t.deps.plugins.start();
    await install(t, 'example');
    const map = (local: string) => t.deps.plugins.testMapping('example', { remote: '/tv', local });
    expect(map(join(dir, 'lib', 'tv'))).toMatchObject({ ok: true });
    expect(map(join(dir, 'lib'))).toMatchObject({ ok: true });
    expect(map(join(dir, 'lib', 'nope'))).toEqual({
      ok: false,
      message: `${join(dir, 'lib', 'nope')} does not exist`,
    });
    expect(map(join(dir, 'lib', 'file.txt'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('not a directory'),
    });
    expect(map(dir)).toMatchObject({
      ok: false,
      message: expect.stringContaining('not inside any library'),
    });
    // A look-alike sibling of the root is outside it.
    await mkdir(join(dir, 'lib2'), { recursive: true });
    expect(map(join(dir, 'lib2'))).toMatchObject({ ok: false });
    expect(() => t.deps.plugins.testMapping('ghost', { remote: '/a', local: '/b' })).toThrow(
      /not installed/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('test(): a reported root folder outside every library, after the form mappings, is a warning', async () => {
    await serve('roots');
    const dir = await tempDir('plugin-roots-');
    await mkdir(join(dir, 'lib', 'movies'), { recursive: true });
    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    const t = setup({ libraryRoots: () => [join(dir, 'lib')] });
    await t.deps.plugins.start();
    await install(t, 'roots');
    const test = (roots: string[], pathMappings: Array<{ remote: string; local: string }> = []) =>
      t.deps.plugins.testSettings('roots', { roots, pathMappings });
    const clean = { ok: true, message: 'reachable' };

    // The service's own folder and no mapping: the warning names the root and asks for a mapping.
    expect(await test(['/data/movies/'])).toEqual({
      ...clean,
      warnings: [
        'root folder /data/movies is not inside any library: add a path mapping from /data/movies to the matching library folder, or a library for it',
      ],
    });
    // Mapped into a library (the unsaved form's mappings count): no warning.
    expect(
      await test(
        ['/data/movies/'],
        [{ remote: '/data/movies', local: join(dir, 'lib', 'movies') }],
      ),
    ).toEqual(clean);
    // Both sides see the same folder, inside a library: no mapping needed.
    expect(await test([join(dir, 'lib', 'movies')])).toEqual(clean);
    // Mapped, but to a folder Transcoda cannot place: the mapped path is named.
    const missing = join(dir, 'elsewhere', 'movies');
    expect(
      await test(['/data/movies'], [{ remote: '/data', local: join(dir, 'elsewhere') }]),
    ).toEqual({
      ...clean,
      warnings: [`root folder /data/movies maps to ${missing}, but ${missing} does not exist`],
    });
    // Entries that are not absolute paths are skipped.
    expect(await test(['movies', ''])).toEqual(clean);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('secrets in plugin fetches', () => {
  it('the stored key reaches the service for a node call and the form key for test(); the plugin never held either, and no log or answer carries them', async () => {
    const seen: Array<{ url: string; key: string | undefined }> = [];
    const target = createServer((req, res) => {
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined });
      res.setHeader('content-type', 'application/json').end('{"ok":true}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    try {
      await serve('fetcher', '0.1.0', {
        // The fixture allows no origin of its own: let it use the configured url.
        edit: (c) => c.replace('\tallowedOrigins: [],', '\tallowedOrigins: ["$settings.url"],'),
        // ...which the manifest must then list, or the start is refused.
        manifest: { network: [{ setting: 'url', label: 'url' }] },
      });
      const lines: unknown[] = [];
      const t = setup({
        // The target listens on loopback, which the proxy refuses: stand it in for a LAN service.
        plugins: { fetchAddresses: { classify: () => 'private' } },
        log: {
          info: (m) => lines.push(m),
          warn: (m) => lines.push(m),
          error: (m) => lines.push(m),
        },
      });
      await t.deps.plugins.start();
      const installed = await install(t, 'fetcher');
      if (!installed.ok) throw new Error(installed.reason);

      const saved = await t.deps.plugins.saveSettings('fetcher', {
        apiKey: 'STORED-KEY-424242',
        url: origin,
      });
      expect(saved.settings).toEqual({ apiKey: { set: true }, url: origin });
      const get = t.deps.nodes.get('fetcher:get')?.def.data;
      if (!get) throw new Error('no data hook');
      const answer = await get(
        { ...fakeHookContext() } as never,
        { url: `${origin}/items`, waitMs: 1 } as never,
      );
      expect(answer).toMatchObject({ value: { status: 200 } });
      expect(seen).toEqual([{ url: '/items', key: 'STORED-KEY-424242' }]);

      // test(): the unsaved form's key, and its url's origin, for this call only.
      seen.length = 0;
      const tested = await t.deps.plugins.testSettings('fetcher', {
        apiKey: 'FORM-KEY-737373',
        url: origin,
      });
      expect(tested).toEqual({ ok: true, message: 'status 200' });
      expect(seen).toEqual([{ url: '/slow', key: 'FORM-KEY-737373' }]);
      // Nothing was saved by the test.
      const row = JSON.stringify(findPluginSettings(t.db, 'fetcher'));
      expect(row).not.toContain('FORM-KEY-737373');
      expect(row).not.toContain('STORED-KEY-424242');
      expect(JSON.stringify([lines, t.events, answer, tested])).not.toMatch(/STORED-KEY|FORM-KEY/);

      // A stored-key test after a candidate one still uses the stored key.
      seen.length = 0;
      await t.deps.plugins.testSettings('fetcher', { apiKey: { set: true }, url: origin });
      expect(seen).toEqual([{ url: '/slow', key: 'STORED-KEY-424242' }]);
    } finally {
      target.close();
    }
  });
});

describe('secrets never leak into logs or events', () => {
  it('nothing the service logs or publishes carries a secret', async () => {
    const lines: unknown[] = [];
    await serve('secrets');
    const t = setup({
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
    });
    await t.deps.plugins.start();
    await install(t, 'secrets');
    await t.deps.plugins.saveSettings('secrets', { apiKey: 'LEAK-CHECK-KEY-3' });
    await t.deps.plugins.testSettings('secrets', { apiKey: 'LEAK-CHECK-KEY-4' });
    await t.deps.plugins.restart('secrets');
    await t.deps.plugins.stop();
    expect(JSON.stringify([lines, t.events])).not.toMatch(/LEAK-CHECK-KEY/);
  });
});
