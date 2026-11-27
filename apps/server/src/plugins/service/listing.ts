import type { PluginDetail, PluginSummary, WorkflowRef } from '@transcoda/contract';
import { PLUGIN_NAME_PATTERN, type PluginState } from '@transcoda/shared';
import type { Installed, Provenance, WorkflowTypes } from './types.ts';

// What the Plugins page lists: a plugin's summary and detail rows, the workflows that use it, and
// the plugins workflows use that are not installed.

/** What a plugin's rows read beyond its record: the service's view of its process and catalog. */
export interface RowParts {
  status(rec: Installed): {
    state: PluginState;
    stateReason: string | null;
    nextRestartAt: string | null;
  };
  blocked(rec: Installed): { reason: string; url: string | null } | null;
  /** The newer catalog version, null when none. */
  updateOf(name: string): string | null;
  lastTest(name: string): PluginSummary['lastTest'];
  provenance(name: string): Provenance | undefined;
  /** Which node types each workflow uses; null before `start()` or when the lookup fails. */
  workflowIndex(): WorkflowTypes | null;
}

export function summaryOf(
  rec: Installed,
  parts: RowParts,
  index = parts.workflowIndex(),
): PluginSummary {
  return {
    name: rec.name,
    version: rec.version,
    enabled: rec.enabled,
    ...parts.status(rec),
    blocked: parts.blocked(rec),
    nodes: rec.nodes.map((n) => n.type),
    hasIntegration: rec.integration !== null,
    updateAvailable: parts.updateOf(rec.name),
    catalogUrl: rec.catalogUrl,
    installedAt: rec.installedAt,
    updatedAt: rec.updatedAt,
    icon: rec.manifest.icon ?? null,
    network: rec.manifest.network ?? null,
    usedBy: usageIn(rec, index),
    lastTest: rec.integration ? parts.lastTest(rec.name) : null,
  };
}

export function detailOf(rec: Installed, parts: RowParts): PluginDetail {
  const i = rec.integration;
  const id = i?.id ?? rec.manifest.integration ?? '';
  const known = parts.provenance(rec.name);
  return {
    ...summaryOf(rec, parts),
    manifest: rec.manifest,
    integration: i
      ? {
          id,
          title: i.title ?? id,
          settingsSchema: i.settingsSchema,
          requires: i.requires ?? null,
        }
      : null,
    triggers: rec.triggers.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      icon: t.icon,
    })),
    provenance: {
      sha256: rec.sha256,
      attestation: known?.attestation ?? null,
      coreTested: known?.coreTested ?? [],
      signedBy: rec.signedBy,
    },
  };
}

export function usageIn(
  rec: Installed,
  index: WorkflowTypes | null,
): Array<WorkflowRef & { active: boolean }> {
  if (index === null || rec.nodes.length === 0) return [];
  const mine = new Set(rec.nodes.map((n) => n.type));
  return index.flatMap(({ workflow, types, activeTypes }) =>
    types.some((t) => mine.has(t))
      ? [{ ...workflow, active: activeTypes.some((t) => mine.has(t)) }]
      : [],
  );
}

/**
 * Plugins that are not installed but whose nodes live workflows use, by the `<plugin>:` prefix
 * of their node types (core's own `core:` aside), with those workflows; by name.
 */
export function missingIn(
  index: WorkflowTypes | null,
  names: () => string[],
): Array<{ name: string; workflows: WorkflowRef[] }> {
  if (index === null) return [];
  const installed = new Set(names());
  const byPlugin = new Map<string, WorkflowRef[]>();
  for (const { workflow, types } of index) {
    const prefixes = new Set(types.map((t) => t.slice(0, t.indexOf(':'))));
    for (const name of prefixes) {
      // A node type's prefix may be no plugin name at all (`0x:y`): it names no plugin to install.
      if (name === 'core' || installed.has(name) || !PLUGIN_NAME_PATTERN.test(name)) continue;
      byPlugin.set(name, [...(byPlugin.get(name) ?? []), workflow]);
    }
  }
  return [...byPlugin]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, workflows]) => ({ name, workflows }));
}
