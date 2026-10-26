// Plugin API answers for the Plugins page tests, built on one base so a test overrides only what
// it is about.
import type { PluginDetail, PluginSummary } from '@transcoda/contract';
import type { PluginCatalogOutput } from '../../plugins/usePlugins.ts';

const at = '2026-10-17T09:00:00.000Z';

export function plugin(over: Partial<PluginSummary> = {}): PluginSummary {
  return {
    name: 'example',
    version: '1.0.0',
    enabled: true,
    state: 'running',
    stateReason: null,
    nextRestartAt: null,
    blocked: null,
    nodes: ['example:shout'],
    hasIntegration: false,
    updateAvailable: null,
    catalogUrl: 'https://catalog.test/index.json',
    installedAt: at,
    updatedAt: at,
    icon: null,
    usedBy: [],
    lastTest: null,
    ...over,
  };
}

export function pluginDetail(over: Partial<PluginDetail> = {}): PluginDetail {
  const base = plugin();
  return {
    ...base,
    manifest: {
      name: base.name,
      version: base.version,
      sdk: '^1',
      nodes: ['example:shout'],
      integration: null,
      triggers: [],
      hooks: [],
    },
    integration: null,
    triggers: [],
    provenance: { sha256: 'a'.repeat(64), attestation: null, coreTested: [], signedBy: null },
    ...over,
  };
}

/** A settings schema as the SDK helpers produce it (`secret()`, `url()`, `pathMappings()`, ...). */
export const SERVICE_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri', description: 'Server URL', 'x-transcoda': 'url' },
    apiKey: {
      type: 'string',
      format: 'password',
      description: 'API key',
      'x-transcoda': 'secret',
    },
    pathMappings: {
      type: 'array',
      description: 'Path mappings',
      default: [],
      items: {
        type: 'object',
        properties: { remote: { type: 'string' }, local: { type: 'string' } },
      },
      'x-transcoda': 'path-mappings',
    },
    insecureTls: {
      type: 'boolean',
      default: false,
      description: 'Allow insecure TLS',
      'x-transcoda': 'insecure-tls',
    },
  },
  required: ['url', 'apiKey'],
} as const;

export function serviceDetail(over: Partial<PluginDetail> = {}): PluginDetail {
  return pluginDetail({
    name: 'service',
    hasIntegration: true,
    integration: {
      id: 'service',
      title: 'Service',
      settingsSchema: SERVICE_SCHEMA as never,
      requires: null,
    },
    ...over,
  });
}

export function catalogOutput(over: Partial<PluginCatalogOutput['catalogs'][number]> = {}) {
  return {
    catalogs: [
      {
        catalogUrl: 'https://catalog.test/index.json',
        official: true,
        signed: true,
        keyIds: ['official-1'],
        error: null,
        plugins: [
          {
            name: 'example',
            title: 'Example',
            description: 'Shouts at your files.',
            latest: '1.0.0',
            installed: null,
            versions: [
              {
                version: '1.0.0',
                sdk: '^1',
                compatible: true,
                coreTested: [],
                sha256: 'abcdef0123456789'.repeat(4),
                size: 1234,
                attestation: 'https://github.com/transcoda/plugins/attestations/1',
                signature: 'https://catalog.test/example-1.0.0.js.sig',
                releasedAt: at,
                blocked: null,
              },
              {
                version: '2.0.0',
                sdk: '^2',
                compatible: false,
                coreTested: [],
                sha256: '0'.repeat(64),
                size: 1234,
                attestation: null,
                signature: null,
                releasedAt: at,
                blocked: null,
              },
            ],
            icon: null,
            nodes: [{ type: 'example:shout', kind: 'action', title: 'Shout' }],
          },
        ],
        ...over,
      },
    ],
    blocklist: {
      url: 'https://catalog.test/blocklist.json',
      error: null,
      fetchedAt: at,
      entries: 3,
    },
  } satisfies PluginCatalogOutput;
}
