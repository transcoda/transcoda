import type { PluginCatalogOutputSchema, PluginDetail, WorkflowRef } from '@transcoda/contract';
import type { NodeMetadata } from '@transcoda/sdk';
import type { JsonValue, PluginManifest } from '@transcoda/shared';
import type { z } from 'zod';
import type { Database } from '../../db/open.ts';
import type { PluginIntegration, TriggerMetadata } from '../../db/repos/plugins.ts';
import type { EngineEvents } from '../../engine/events.ts';
import type { NodeRegistry } from '../../nodes/registry.ts';
import type { Config } from '../../platform/config.ts';
import type { Logger } from '../../platform/logger.ts';
import type { WorkflowService } from '../../workflows/service.ts';
import type { Installer } from '../installer.ts';
import type { FetchProxyDeps } from '../network/fetch-proxy.ts';
import type { PluginSupervisor, SupervisorDeps } from '../runtime/supervisor.ts';
import type { CatalogClient } from '../trust/catalog.ts';

// The plugin service's types: its dependencies, its answers, and the record of an installed plugin.

export type PluginCatalogOutput = z.infer<typeof PluginCatalogOutputSchema>;
export type InstallResult = { ok: true; plugin: PluginDetail } | { ok: false; reason: string };
export type UpdateCheckResult =
  | {
      ok: true;
      /**
       * Workflows whose active version (`version`) would stop running: its node version is
       * dropped, or its migration path changes behavior and needs a review first.
       */
      wouldBreak: Array<
        WorkflowRef & { active: boolean; version: number; reason: 'dropped' | 'behaviour' }
      >;
      /** Workflows whose newest (not active) version is affected; their active version is not. */
      needsReview: WorkflowRef[];
      /** The new manifest does not list node versions: nothing can be checked. */
      unknown: boolean;
    }
  | { ok: false; reason: string };

export interface PluginServiceDeps {
  db: Database;
  config: Pick<
    Config,
    | 'pluginsDir'
    | 'pluginHostPath'
    | 'pluginCatalogUrl'
    | 'pluginCatalogKeys'
    | 'pluginBlocklistUrl'
    | 'catalogToken'
    | 'devPlugins'
    | 'pluginInspect'
    | 'pluginIsolation'
    | 'nodeEnv'
  >;
  secretKey: Buffer;
  registry: NodeRegistry;
  workflows: WorkflowService;
  events: EngineEvents;
  now(): Date;
  log: Logger;
  /** Default SDK_VERSION. */
  sdkVersion?: string | undefined;
  installer?: Installer | undefined;
  catalog?: CatalogClient | undefined;
  supervisor?: PluginSupervisor | undefined;
  /** Reads a host's OS identity for the isolation check (default `/proc`); tests inject one. */
  identityOf?: SupervisorDeps['identityOf'];
  /** Fetch-proxy name resolution and address classification (tests stand loopback in for a LAN). */
  fetchAddresses?: Pick<FetchProxyDeps, 'resolve' | 'classify'> | undefined;
  /** Library roots, for `testMapping`. */
  libraryRoots(): string[];
}

export type JsonObject = Record<string, JsonValue>;
export type WorkflowTypes = ReturnType<WorkflowService['nodeTypesInUse']>;

export interface Installed {
  name: string;
  version: string;
  enabled: boolean;
  catalogUrl: string | null;
  sha256: string;
  manifest: PluginManifest;
  nodes: NodeMetadata[];
  integration: PluginIntegration | null;
  triggers: TriggerMetadata[];
  signedBy: string | null;
  installedAt: string;
  updatedAt: string;
  /** From TRANSCODA_DEV_PLUGINS: in memory only. */
  dev: boolean;
}

/** Where an installed build came from, as its catalog says (kept in memory). */
export interface Provenance {
  attestation: string | null;
  coreTested: string[];
}
