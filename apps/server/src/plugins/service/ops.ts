import type { PluginDetail } from '@transcoda/contract';
import type { NodeMetadata } from '@transcoda/sdk';
import type { RegisteredNode } from '../../nodes/registry.ts';
import type { SigningKey } from '../../platform/signing-keys.ts';
import type { Installer } from '../installer.ts';
import type { PluginRuntime, PluginSupervisor } from '../runtime/supervisor.ts';
import type { BlocklistClient } from '../trust/blocklist.ts';
import type { PluginCatalogs } from './catalogs.ts';
import type { Installed, JsonObject, PluginServiceDeps, Provenance } from './types.ts';

/**
 * What install and update work with: the service's parts and the few of its own steps they share
 * with it. The service builds one and hands it to `install.ts` and `update.ts`.
 */
export interface ServiceOps {
  deps: PluginServiceDeps;
  installer: Installer;
  supervisor: PluginSupervisor;
  blocklist: BlocklistClient;
  catalogs: PluginCatalogs;
  sdkVersion: string;
  provenance: Map<string, Provenance>;
  record(name: string): Installed | null;
  need(name: string): Installed;
  runtimeOf(rec: Installed, settings: JsonObject): PluginRuntime;
  prepareBundle(
    rt: PluginRuntime,
    keys: readonly SigningKey[] | null,
  ): Promise<{ ok: true; bundlePath: string } | { ok: false; reason: string }>;
  unstage(name: string, version: string): Promise<void>;
  nodeEntries(name: string, version: string, nodes: NodeMetadata[]): RegisteredNode[];
  registerNodes(name: string, version: string, nodes: NodeMetadata[]): void;
  /** Publishes plugins.changed for the plugin. */
  publish(name: string): void;
  detailOrThrow(name: string): PluginDetail;
}
