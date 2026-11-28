import { describe, expect, it } from 'vitest';
import {
  contract,
  errorDefs,
  PluginCatalogAddInputSchema,
  PluginCatalogOutputSchema,
  PluginCatalogVersionSchema,
  PluginDetailSchema,
  PluginRemoveInputSchema,
  PluginSettingsGetOutputSchema,
  PluginSummarySchema,
  PluginsListOutputSchema,
  SecretMarkerSchema,
} from '../index.ts';

describe('plugins router', () => {
  it('exposes the plugins router', () => {
    expect(Object.keys(contract)).toContain('plugins');
    expect(Object.keys(contract.plugins)).toEqual([
      'list',
      'catalog',
      'catalogsAdd',
      'catalogsRemove',
      'get',
      'install',
      'update',
      'updateCheck',
      'remove',
      'enable',
      'disable',
      'restart',
      'settingsGet',
      'settingsSave',
      'settingsTest',
      'testMapping',
    ]);
  });
});

const blocklist = {
  url: 'https://example.com/blocklist.json',
  error: null,
  fetchedAt: '2026-10-17T12:00:00.000Z',
  entries: 2,
};

describe('plugin schemas', () => {
  it('the summary carries no settings, secret, token or key field', () => {
    for (const key of Object.keys(PluginSummarySchema.shape)) {
      expect(key).not.toMatch(/settings|secret|token|key/i);
    }
  });

  it('settings answer parses a masked secret', () => {
    expect(
      PluginSettingsGetOutputSchema.safeParse({
        settings: { apiKey: { set: true } },
        lastTest: null,
        needsReview: null,
      }).success,
    ).toBe(true);
  });

  it('defines the plugin errors', () => {
    expect(errorDefs.PLUGIN_INSTALL_FAILED.status).toBe(422);
    expect(errorDefs.PLUGIN_SETTINGS_INVALID.status).toBe(422);
    expect(errorDefs.PLUGIN_NOT_RUNNING.status).toBe(409);
  });

  it('a catalog is added with optional <keyId>:<64 hex> signing keys', () => {
    expect(
      PluginCatalogAddInputSchema.safeParse({ url: 'https://example.com/c.json' }).success,
    ).toBe(true);
    const ok = { url: 'https://example.com/c.json', signingKeys: `k1:${'ab'.repeat(32)}` };
    expect(PluginCatalogAddInputSchema.safeParse(ok).success).toBe(true);
    const two = { ...ok, signingKeys: `k1:${'ab'.repeat(32)},k2:${'cd'.repeat(32)}` };
    expect(PluginCatalogAddInputSchema.safeParse(two).success).toBe(true);
    for (const signingKeys of [
      'ab',
      'ab'.repeat(32),
      `k1:${'AB'.repeat(32)}`,
      `k1:${'g'.repeat(64)}`,
      `k1:${'ab'.repeat(32)}0`,
      `:${'ab'.repeat(32)}`,
      `k1:${'ab'.repeat(32)},`,
    ]) {
      expect(PluginCatalogAddInputSchema.safeParse({ ...ok, signingKeys }).success).toBe(false);
    }
  });

  it('the catalog output carries signed, keyIds and each version its signature url', () => {
    const base = {
      catalogUrl: 'https://example.com/c.json',
      official: true,
      error: null,
      plugins: [],
    };
    expect(PluginCatalogOutputSchema.safeParse({ catalogs: [base], blocklist }).success).toBe(
      false,
    );
    expect(
      PluginCatalogOutputSchema.safeParse({ catalogs: [{ ...base, signed: true }], blocklist })
        .success,
    ).toBe(false);
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [{ ...base, signed: true, keyIds: ['k1'] }],
        blocklist,
      }).success,
    ).toBe(true);
  });

  it('the catalog output carries the blocklist status, and a build or plugin its blocked reason', () => {
    const catalog = {
      catalogUrl: 'https://example.com/c.json',
      official: true,
      signed: true,
      keyIds: ['k1'],
      error: null,
      plugins: [],
    };
    expect(PluginCatalogOutputSchema.safeParse({ catalogs: [catalog] }).success).toBe(false);
    for (const bad of [
      { ...blocklist, entries: -1 },
      { ...blocklist, fetchedAt: 'yesterday' },
      { url: blocklist.url, error: null, entries: 0 },
    ]) {
      expect(
        PluginCatalogOutputSchema.safeParse({ catalogs: [catalog], blocklist: bad }).success,
      ).toBe(false);
    }
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [catalog],
        blocklist: {
          url: blocklist.url,
          error: 'blocklist signature missing',
          fetchedAt: null,
          entries: 0,
        },
      }).success,
    ).toBe(true);
    expect(Object.keys(PluginSummarySchema.shape)).toContain('blocked');
    const blocked = PluginSummarySchema.shape.blocked;
    expect(blocked.safeParse(null).success).toBe(true);
    expect(blocked.safeParse({ reason: 'Exfiltrates tokens', url: null }).success).toBe(true);
    expect(blocked.safeParse({ reason: 'x', url: 'https://example.com/a' }).success).toBe(true);
    expect(blocked.safeParse({ reason: 'x' }).success).toBe(false);
    expect(blocked.safeParse(undefined).success).toBe(false);
  });

  it('plugin provenance names the key that signed the install, or null', () => {
    const p = { sha256: 'a'.repeat(64), attestation: null, coreTested: [] };
    const shape = PluginDetailSchema.shape.provenance;
    expect(shape.safeParse(p).success).toBe(false);
    expect(shape.safeParse({ ...p, signedBy: null }).success).toBe(true);
    expect(shape.safeParse({ ...p, signedBy: 'k1' }).success).toBe(true);
  });

  it('remove needs confirm: true', () => {
    expect(PluginRemoveInputSchema.safeParse({ name: 'example', confirm: false }).success).toBe(
      false,
    );
    expect(PluginRemoveInputSchema.safeParse({ name: 'example', confirm: true }).success).toBe(
      true,
    );
  });

  it('parses a catalog with versions and a secret marker', () => {
    const v = {
      version: '1.0.0',
      sdk: '^1',
      compatible: true,
      coreTested: ['0.3.0'],
      sha256: 'a'.repeat(64),
      size: 10,
      attestation: null,
      signature: null,
      releasedAt: '2026-10-17',
      blocked: null,
      network: null,
    };
    const version = PluginCatalogVersionSchema;
    expect(version.safeParse({ ...v, network: undefined }).success).toBe(false);
    expect(
      version.safeParse({ ...v, network: [{ setting: 'url', label: 'Sonarr URL' }] }).success,
    ).toBe(true);
    expect(version.safeParse({ ...v, network: [] }).success).toBe(true);
    expect(version.safeParse({ ...v, network: [{ origin: '*.example.com' }] }).success).toBe(false);
    expect(
      PluginCatalogOutputSchema.safeParse({
        catalogs: [
          {
            catalogUrl: 'https://example.com/c.json',
            official: false,
            signed: false,
            keyIds: [],
            error: null,
            plugins: [
              {
                name: 'example',
                title: 'E',
                description: 'd',
                latest: '1.0.0',
                installed: null,
                versions: [v],
                icon: null,
                nodes: [
                  { type: 'example:a', kind: 'finish', title: 'Notify' },
                  { type: 'example:b', kind: null, title: null },
                ],
              },
            ],
          },
        ],
        blocklist,
      }).success,
    ).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true }).success).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true, value: 'x' }).success).toBe(false);
    expect(SecretMarkerSchema.safeParse({ set: true, endsWith: '4f2a' }).success).toBe(true);
    expect(SecretMarkerSchema.safeParse({ set: true, endsWith: '4f2a5' }).success).toBe(false);
  });

  it('the list carries what each plugin is used by, its last connection test (no message) and the plugins workflows miss', () => {
    const summary = {
      name: 'example',
      version: '1.0.0',
      enabled: true,
      state: 'running',
      stateReason: null,
      nextRestartAt: null,
      blocked: null,
      nodes: ['example:a'],
      hasIntegration: true,
      updateAvailable: null,
      catalogUrl: null,
      installedAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:00:00.000Z',
      icon: null,
      network: [{ origin: 'https://discord.com' }],
      usedBy: [{ id: 'w1', name: 'TV cleanup', active: true }],
      lastTest: { at: '2026-10-17T12:00:00.000Z', ok: false, kind: 'unreachable' },
    };
    const out = {
      plugins: [summary],
      missing: [{ name: 'sonarr', workflows: [{ id: 'w1', name: 'TV cleanup' }] }],
    };
    expect(PluginsListOutputSchema.safeParse(out).success).toBe(true);
    expect(PluginsListOutputSchema.safeParse({ plugins: [summary] }).success).toBe(false);
    expect(Object.keys(PluginSummarySchema.shape.lastTest.unwrap().shape)).toEqual([
      'at',
      'ok',
      'kind',
    ]);
  });
});
