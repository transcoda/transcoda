import type { NodeMetadata } from '@transcoda/sdk';
import type { HostReady } from '@transcoda/shared';
import { deletePlugin, insertPlugin } from '../../db/repos/plugins.ts';
import type { ExitReason } from '../runtime/process.ts';
import type { PluginRuntime } from '../runtime/supervisor.ts';
import { policyOf } from '../settings.ts';
import { blockedReason, messageOf, realOrSame, startFailure } from './helpers.ts';
import type { ServiceOps } from './ops.ts';
import type { InstallResult } from './types.ts';
import { upgradeWorkflows } from './update.ts';

// Installing a plugin from a catalog: download, verify, start, register its nodes, record it.

const NO_ORIGINS = { allowedOrigins: [], allowInsecureTls: false };

export async function doInstall(
  ops: ServiceOps,
  input: {
    name: string;
    version: string;
    catalogUrl: string;
  },
): Promise<InstallResult> {
  const { name, version, catalogUrl } = input;
  const { db, registry } = ops.deps;
  if (ops.record(name) !== null)
    return { ok: false, reason: `plugin ${name} is already installed` };
  if (!ops.catalogs.urls().includes(catalogUrl)) {
    return { ok: false, reason: 'that catalog is not one of the configured catalogs' };
  }
  const found = await ops.catalogs.find(catalogUrl, name, version);
  if (!found.ok) return found;
  const listed = ops.blocklist.match({ name, version, sha256: found.version.sha256 });
  if (listed !== null) return { ok: false, reason: blockedReason(listed) };
  // No row, so any files under this name are leftovers of a crash: clear them for a clean write.
  await ops.installer.remove(name, version).catch(() => undefined);
  const dl = await ops.installer.download(
    { name, ...found.version, keys: ops.catalogs.keysFor(catalogUrl) },
    ops.sdkVersion,
  );
  if (!dl.ok) {
    return { ok: false, reason: dl.reason === 'checksum' ? 'checksum mismatch' : dl.message };
  }
  const runtime: PluginRuntime = {
    name,
    version,
    bundlePath: realOrSame(dl.bundlePath),
    sha256: found.version.sha256,
    manifest: dl.manifest,
    settings: {},
    policy: { ...NO_ORIGINS },
    enabled: true,
    secretKeys: [],
  };
  const rollback = async (reason: string): Promise<InstallResult> => {
    await ops.supervisor.remove(name).catch(() => undefined);
    registry.removeBySource(name);
    deletePlugin(db, name);
    await ops.installer.remove(name, version).catch(() => undefined);
    await ops.unstage(name, version);
    return { ok: false, reason };
  };
  let ready: HostReady | { error: ExitReason } | null;
  try {
    ready = await ops.supervisor.add(runtime);
  } catch (err) {
    return rollback(messageOf(err));
  }
  if (ready === null || 'error' in ready) {
    return rollback(startFailure(ready === null ? { kind: 'stopped' } : ready.error));
  }
  const nodes = ready.nodes as unknown as NodeMetadata[];
  try {
    ops.registerNodes(name, version, nodes);
    insertPlugin(
      db,
      {
        name,
        version,
        enabled: true,
        catalogUrl,
        sha256: found.version.sha256,
        manifest: dl.manifest,
        nodes,
        integration: ready.integration,
        triggers: ready.triggers,
        signedBy: dl.signedBy,
      },
      ops.deps.now(),
    );
  } catch (err) {
    return rollback(messageOf(err));
  }
  // Fresh install: no settings yet, but literal origins (an API host) apply from the start.
  ops.supervisor.setPolicy(name, policyOf(ready.integration, {}));
  ops.provenance.set(name, {
    attestation: found.version.attestation,
    coreTested: found.version.coreTested,
  });
  ops.publish(name);
  ops.deps.log.info({ msg: 'plugin installed', plugin: name, version });
  await upgradeWorkflows(ops, name);
  return { ok: true, plugin: ops.detailOrThrow(name) };
}
