import type { WorkflowRef } from '@transcoda/contract';
import type { NodeMetadata } from '@transcoda/sdk';
import { updatePlugin } from '../../db/repos/plugins.ts';
import type { RegisteredNode } from '../../nodes/registry.ts';
import { stepsBetween } from '../../workflows/upgrade.ts';
import type { PluginRuntime } from '../runtime/supervisor.ts';
import { openStoredSettings, policyOf } from '../settings.ts';
import { blockedReason, isObject, messageOf, realOrSame, startFailure } from './helpers.ts';
import type { ServiceOps } from './ops.ts';
import type { InstallResult, UpdateCheckResult } from './types.ts';

// Updating an installed plugin: the new build starts beside the old one and takes over only once
// nothing can refuse; what an update would do to workflows; moving workflows to new node versions.

export async function doUpdate(
  ops: ServiceOps,
  name: string,
  version: string,
): Promise<InstallResult> {
  const { db, registry } = ops.deps;
  const rec = ops.need(name);
  if (rec.dev) return { ok: false, reason: `${name} is a dev plugin; rebuild it instead` };
  if (rec.version === version)
    return { ok: false, reason: `${name} ${version} is already installed` };
  if (rec.catalogUrl === null || !ops.catalogs.urls().includes(rec.catalogUrl)) {
    return { ok: false, reason: 'the catalog this plugin came from is no longer configured' };
  }
  const found = await ops.catalogs.find(rec.catalogUrl, name, version);
  if (!found.ok) return found;
  const listed = ops.blocklist.match({ name, version, sha256: found.version.sha256 });
  if (listed !== null) return { ok: false, reason: blockedReason(listed) };
  const dl = await ops.installer.download(
    { name, ...found.version, keys: ops.catalogs.keysFor(rec.catalogUrl) },
    ops.sdkVersion,
  );
  if (!dl.ok) {
    return { ok: false, reason: dl.reason === 'checksum' ? 'checksum mismatch' : dl.message };
  }
  const discardFiles = async () => {
    await ops.installer.remove(name, version).catch(() => undefined);
    await ops.unstage(name, version);
  };
  const { settings } = openStoredSettings(ops.deps.db, ops.deps.secretKey, name);
  const next: PluginRuntime = {
    ...ops.runtimeOf(rec, settings),
    version,
    bundlePath: realOrSame(dl.bundlePath),
    sha256: found.version.sha256,
    manifest: dl.manifest,
  };
  // `startCandidate` bypasses the supervisor's verify seam: the same verify-and-stage runs here.
  const prepared = await ops.prepareBundle(
    next,
    dl.signedBy === null ? null : ops.catalogs.keysFor(rec.catalogUrl),
  );
  if (!prepared.ok) {
    await discardFiles();
    return { ok: false, reason: prepared.reason };
  }
  next.bundlePath = prepared.bundlePath;
  const candidate = await ops.supervisor.startCandidate(name, next);
  if ('error' in candidate) {
    await discardFiles();
    return { ok: false, reason: startFailure(candidate.error) };
  }
  const nodes = candidate.ready.nodes as unknown as NodeMetadata[];
  let entries: RegisteredNode[];
  try {
    // Everything that can refuse happens before the old version is touched.
    const types = new Set<string>();
    for (const meta of nodes) {
      if (types.has(meta.type)) throw new Error(`node type ${meta.type} is provided twice`);
      types.add(meta.type);
      const existing = registry.get(meta.type);
      if (existing && !(existing.source.kind === 'plugin' && existing.source.name === name)) {
        const by = existing.source.kind === 'core' ? 'core' : `plugin ${existing.source.name}`;
        throw new Error(`node type ${meta.type} is already provided by ${by}`);
      }
    }
    entries = ops.nodeEntries(name, version, nodes);
  } catch (err) {
    await candidate.discard();
    await discardFiles();
    return { ok: false, reason: messageOf(err) };
  }
  const oldNodes = registry
    .list()
    .filter((n) => n.source.kind === 'plugin' && n.source.name === name);
  // The swap: the new process takes over, and in the same tick the new definitions replace the old.
  const committed = candidate.commit();
  registry.removeBySource(name);
  try {
    registry.add(entries);
  } catch (err) {
    // Not expected (checked above); if it happens the old definitions are back, and the plugin,
    // already running the new bundle, is stopped rather than serving them.
    registry.add(oldNodes);
    await committed.catch(() => undefined);
    await ops.supervisor.markStopped(
      name,
      `update could not register its nodes: ${messageOf(err)}`,
    );
    return { ok: false, reason: messageOf(err) };
  }
  await committed;
  updatePlugin(
    db,
    name,
    {
      version,
      sha256: found.version.sha256,
      manifest: dl.manifest,
      nodes,
      integration: candidate.ready.integration,
      triggers: candidate.ready.triggers,
      signedBy: dl.signedBy,
    },
    ops.deps.now(),
  );
  ops.supervisor.setPolicy(name, policyOf(candidate.ready.integration, settings));
  await ops.unstage(name, rec.version);
  // A disabled plugin only took the new bundle: it stages again when it is enabled.
  if (!rec.enabled) await ops.unstage(name, version);
  await ops.installer.remove(name, rec.version).catch((err: unknown) => {
    ops.deps.log.warn({
      msg: 'old plugin files not removed',
      plugin: name,
      error: messageOf(err),
    });
  });
  ops.provenance.set(name, {
    attestation: found.version.attestation,
    coreTested: found.version.coreTested,
  });
  ops.catalogs.forgetUpdate(name);
  ops.publish(name);
  ops.deps.log.info({ msg: 'plugin updated', plugin: name, from: rec.version, to: version });
  await upgradeWorkflows(ops, name);
  return { ok: true, plugin: ops.detailOrThrow(name) };
}

/**
 * Writes new workflow versions for plugin nodes pinned to older node versions, through the
 * plugin's own `migrate`. Best effort: a failure is logged and never refuses the plugin action.
 */
export async function upgradeWorkflows(ops: ServiceOps, name: string): Promise<void> {
  const rec = ops.record(name);
  if (!rec || rec.nodes.length === 0 || ops.supervisor.status(name)?.state !== 'running') return;
  try {
    await ops.deps.workflows.upgradePluginNodes(
      rec.nodes.map((n) => n.type),
      async (nodeType, from, settings) => {
        const r = await ops.supervisor.migrate(name, nodeType, from, settings);
        if (!r.ok) throw new Error(r.error.message);
        const out = r.result;
        if (!isObject(out) || out.settings === undefined) {
          throw new Error(`plugin ${name} answered migrate without settings`);
        }
        return out.settings;
      },
    );
  } catch (err) {
    ops.deps.log.warn({
      msg: 'plugin node upgrades failed',
      plugin: name,
      error: messageOf(err),
    });
  }
}

/**
 * Which workflows an update to `version` would affect, from the new release's manifest alone
 * (nothing is installed or started). Refusals are the ones `update` gives.
 */
export async function updateCheck(
  ops: ServiceOps,
  name: string,
  version: string,
): Promise<UpdateCheckResult> {
  const rec = ops.need(name);
  if (rec.dev) return { ok: false, reason: `${name} is a dev plugin; rebuild it instead` };
  if (rec.version === version)
    return { ok: false, reason: `${name} ${version} is already installed` };
  if (rec.catalogUrl === null || !ops.catalogs.urls().includes(rec.catalogUrl)) {
    return { ok: false, reason: 'the catalog this plugin came from is no longer configured' };
  }
  const found = await ops.catalogs.find(rec.catalogUrl, name, version);
  if (!found.ok) return found;
  const fetched = await ops.installer.fetchManifest({ name, ...found.version }, ops.sdkVersion);
  if (!fetched.ok) return { ok: false, reason: fetched.message };
  const served = fetched.manifest.nodeVersions;
  if (served === undefined) return { ok: true, wouldBreak: [], needsReview: [], unknown: true };
  const wouldBreak = new Map<
    string,
    WorkflowRef & { active: boolean; version: number; reason: 'dropped' | 'behaviour' }
  >();
  const needsReview = new Map<string, WorkflowRef>();
  for (const entry of ops.deps.workflows.pinnedNodes(rec.nodes.map((n) => n.type))) {
    let noPath = false;
    let behaviour = false;
    for (const node of entry.nodes) {
      const next = served.find((s) => s.type === node.type);
      const steps = next ? stepsBetween(next.migrations, node.typeVersion, next.version) : null;
      if (steps === null) noPath = true;
      else if (steps.some((st) => st.risk !== 'safe')) behaviour = true;
    }
    const ref = { id: entry.workflow.id, name: entry.workflow.name };
    if (entry.active && (noPath || behaviour)) {
      // Never "keeps running": a dropped version has no path, a behaviour step is held.
      const dropped = noPath || wouldBreak.get(ref.id)?.reason === 'dropped';
      wouldBreak.set(ref.id, {
        ...ref,
        active: true,
        version: entry.version,
        reason: dropped ? 'dropped' : 'behaviour',
      });
    } else if (noPath || behaviour) needsReview.set(ref.id, ref);
  }
  const byName = (a: WorkflowRef, b: WorkflowRef) => a.name.localeCompare(b.name);
  return {
    ok: true,
    wouldBreak: [...wouldBreak.values()].sort(byName),
    needsReview: [...needsReview.values()].filter((w) => !wouldBreak.has(w.id)).sort(byName),
    unknown: false,
  };
}
