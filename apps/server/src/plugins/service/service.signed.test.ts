import { generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../app/testing/app.ts';
import { findPlugin, listCatalogs } from '../../db/repos/plugins.ts';
import { signText } from '../testing/sign.ts';

import {
  base,
  files,
  indexUrl,
  install,
  refresh,
  serve,
  setup,
  signing,
  useTestCatalog,
} from './testing.ts';

useTestCatalog();

describe('signed bundles', () => {
  const customUrl = (): string => `${base}/custom.json`;
  const installFrom = async (app: TestApp, url: string, name = 'example') => {
    await refresh(app);
    return app.deps.plugins.install({ name, version: '0.1.0', catalogUrl: url });
  };

  it('installing from a signed catalog stores the signature and records the key', async () => {
    signing.on = true;
    await serve('example');
    const t = setup({ catalogKeys: signing.keys });
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBe('k1');
    expect(findPlugin(t.db, 'example')?.signedBy).toBe('k1');
    expect(await files(t)).toEqual([
      'example-0.1.0.js',
      'example-0.1.0.js.sig',
      'example-0.1.0.manifest.json',
    ]);
    const out = await t.deps.plugins.catalog(false);
    expect(out.catalogs[0]).toMatchObject({ official: true, signed: true });
    expect(out.catalogs[0]?.plugins[0]?.versions[0]?.signature).toBe(
      `${base}/example-0.1.0.js.sig`,
    );
  });

  it('an unsigned install records no key and the catalog says unsigned', async () => {
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    const result = await install(t, 'example');
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBeNull();
    expect((await t.deps.plugins.catalog(false)).catalogs[0]?.signed).toBe(false);
  });

  it('a signed catalog whose version has no bundle signature is refused', async () => {
    await serve('example');
    signing.on = true;
    signing.noBundleSig = true;
    // the index is signed but carries no bundle signature url
    const t = setup({ catalogKeys: signing.keys });
    await t.deps.plugins.start();
    expect(await install(t, 'example')).toEqual({
      ok: false,
      reason: 'the catalog is signed but this version has no bundle signature',
    });
    expect(await files(t)).toEqual([]);
  });

  it('a .sig tampered with on disk stops the plugin at its next start', async () => {
    signing.on = true;
    await serve('example');
    const first = setup({ catalogKeys: signing.keys });
    await first.deps.plugins.start();
    expect((await install(first, 'example')).ok).toBe(true);
    await first.deps.plugins.stop();
    const sig = join(first.deps.config.pluginsDir, 'example-0.1.0.js.sig');
    await writeFile(sig, signText(Buffer.from('other'), signing.privateKey, signing.keyId));
    const second = setup({
      db: first.db,
      pluginsDir: first.deps.config.pluginsDir,
      catalogKeys: signing.keys,
    });
    await second.deps.plugins.start();
    expect(second.deps.plugins.get('example')).toMatchObject({
      state: 'stopped',
      stateReason: 'bundle signature invalid; reinstall',
    });
    await writeFile(sig, signText(Buffer.from('x'), signing.privateKey, signing.keyId));
    await rm(sig);
    await expect(second.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'bundle signature missing; reinstall',
    });
  });

  it('a custom catalog added with a public key is verified; its install is signed by key k1', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    const result = await installFrom(t, customUrl());
    if (!result.ok) throw new Error(result.reason);
    expect(result.plugin.provenance.signedBy).toBe('k1');
    expect(
      (await t.deps.plugins.catalog(false)).catalogs.map((c) => [c.official, c.signed, c.keyIds]),
    ).toEqual([
      [true, false, []],
      [false, true, ['k1']],
    ]);
  });

  it('B4: a signed custom catalog that is removed leaves the plugin stopped at its next start', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    expect((await installFrom(t, customUrl())).ok).toBe(true);
    t.deps.plugins.removeCatalog(customUrl());
    await expect(t.deps.plugins.restart('example')).resolves.toMatchObject({
      state: 'stopped',
      stateReason: 'signed with an unknown key k1; update the plugin',
    });
  });

  it('a wrong key for a custom catalog is a catalog error, not an install', async () => {
    signing.on = true;
    await serve('example');
    const t = setup();
    await t.deps.plugins.start();
    t.deps.plugins.addCatalog(customUrl(), generateKeyPairSyncHex());
    const out = await t.deps.plugins.catalog(true);
    expect(out.catalogs[1]?.error).toMatch(/catalog signature invalid/);
  });

  it('adding a known url with keys replaces them, without keys keeps them; bad keys, a query string and the official url are refused', async () => {
    const t = setup();
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db)).toEqual([{ url: customUrl(), signingKeys: null }]);
    t.deps.plugins.addCatalog(customUrl(), signing.keySpec);
    expect(listCatalogs(t.db)).toEqual([{ url: customUrl(), signingKeys: signing.keySpec }]);
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db)[0]?.signingKeys).toBe(signing.keySpec);
    for (const bad of ['abc', signing.publicHex, `k1:${'A'.repeat(64)}`, '']) {
      expect(() => t.deps.plugins.addCatalog(customUrl(), bad)).toThrow(/expected <id>:<64 hex>/);
    }
    expect(() => t.deps.plugins.addCatalog(`${customUrl()}?x=1`, signing.keySpec)).toThrow(
      'a signed catalog url may not have a query string',
    );
    expect(() => t.deps.plugins.addCatalog(indexUrl, signing.keySpec)).toThrow(
      "the official catalog's key is set by TRANSCODA_PLUGIN_CATALOG_KEY",
    );
    // without keys a query string stays fine
    t.deps.plugins.addCatalog(`${customUrl()}?x=1`);
    // unpinning is remove, then add
    t.deps.plugins.removeCatalog(customUrl());
    t.deps.plugins.addCatalog(customUrl());
    expect(listCatalogs(t.db).find((c) => c.url === customUrl())?.signingKeys).toBeNull();
  });
});

function generateKeyPairSyncHex(): string {
  const spki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return `k1:${spki.subarray(spki.length - 32).toString('hex')}`;
}
