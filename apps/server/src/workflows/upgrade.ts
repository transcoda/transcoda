import {
  type AnyNodeDefinition,
  type MigrationRisk,
  type NodeMigration,
  parseSettings,
} from '@transcoda/sdk';
import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import type { NodeRegistry } from '../nodes/registry.ts';
import { isRemoteDefinition } from '../nodes/remote.ts';
import { isKnownOverrideKey, splitOverrideKey } from './subworkflow-settings.ts';

/** The links of a migration chain: all a remote node's manifest entry carries. */
export type MigrationStep = { from: number; to: number; risk: MigrationRisk };

/**
 * Migration steps from `from` to `to`, each step's `to` being the next step's `from`.
 * `[]` when from === to; `null` when either version is not an integer, or a link is missing,
 * ambiguous (two steps share a `from`), does not move forward, or overshoots `to`.
 */
export function stepsBetween<T extends MigrationStep>(
  steps: readonly T[],
  from: number,
  to: number,
): T[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return null;
  const chain: T[] = [];
  let current = from;
  while (current < to) {
    const candidates = steps.filter((m) => m.from === current);
    const step = candidates[0];
    if (candidates.length !== 1 || !step || step.to <= current || step.to > to) return null;
    chain.push(step);
    current = step.to;
  }
  return chain;
}

function chainBetween(def: AnyNodeDefinition, from: number, to: number): NodeMigration[] | null {
  return stepsBetween(def.migrations ?? [], from, to);
}

export function migrationPath(def: AnyNodeDefinition, from: number): NodeMigration[] | null {
  return chainBetween(def, from, def.version);
}

/**
 * `edges` with the edges leaving the given nodes re-keyed by the output renames of the
 * migration steps those nodes went through. Returns `edges` itself when nothing changes.
 */
export function rekeyEdges(
  edges: WorkflowGraph['edges'],
  migrated: ReadonlyMap<string, readonly NodeMigration[]>,
): WorkflowGraph['edges'] {
  let changed = false;
  const next = edges.map((e) => {
    const steps = migrated.get(e.from.node);
    if (!steps) return e;
    const port = steps.reduce((p, st) => st.renameOutputs?.[p] ?? p, e.from.port);
    if (port === e.from.port) return e;
    changed = true;
    return { ...e, from: { ...e.from, port } };
  });
  return changed ? next : edges;
}

export type UpgradePlan =
  | { kind: 'current' }
  | { kind: 'broken'; nodeIds: string[] }
  | { kind: 'upgraded'; graph: WorkflowGraph; risk: MigrationRisk; notes: string[] };

export function applySteps(settings: JsonValue, steps: NodeMigration[]): JsonValue {
  return steps.reduce<JsonValue>((s, step) => step.migrate(structuredClone(s)), settings);
}

/**
 * Plans the node-type migrations for a graph. Whole-graph atomic: if any outdated node has
 * no migration path, nothing is migrated. A throwing `migrate` propagates (callers catch).
 */
export function planNodeUpgrades(graph: WorkflowGraph, registry: NodeRegistry): UpgradePlan {
  const pending: Array<{ index: number; def: AnyNodeDefinition; steps: NodeMigration[] }> = [];
  const broken: string[] = [];
  graph.nodes.forEach((n, index) => {
    const def = registry.get(n.type)?.def;
    if (!def || n.typeVersion >= def.version) return;
    const steps = migrationPath(def, n.typeVersion);
    if (steps === null) broken.push(n.id);
    // A plugin node with a path stays as stored: its host migrates the settings when the node
    // runs, and `applyPluginUpgrades` writes them once the plugin is up.
    else if (!isRemoteDefinition(def)) pending.push({ index, def, steps });
  });
  if (broken.length > 0) return { kind: 'broken', nodeIds: broken };
  if (pending.length === 0) return { kind: 'current' };

  const nodes = [...graph.nodes];
  const notes: string[] = [];
  const migrated = new Map<string, NodeMigration[]>();
  let risk: MigrationRisk = 'safe';
  for (const { index, def, steps } of pending) {
    const original = nodes[index] as NodeInstance;
    migrated.set(original.id, steps);
    nodes[index] = {
      ...original,
      typeVersion: def.version,
      settings: applySteps(original.settings, steps),
    };
    const behaviourNotes = steps.filter((s) => s.risk !== 'safe').map((s) => ` (${s.note})`);
    if (behaviourNotes.length > 0) risk = 'behaviour';
    notes.push(
      `Updated ${def.title} ${original.typeVersion}→${def.version}${behaviourNotes.join('')}`,
    );
  }
  return {
    kind: 'upgraded',
    graph: { ...graph, nodes, edges: rekeyEdges(graph.edges, migrated) },
    risk,
    notes,
  };
}

/** The settings size a migration may produce (the plugin host enforces the same cap). */
const MAX_MIGRATED_BYTES = 256 * 1024;

export interface PluginNodeBehind {
  nodeId: string;
  type: string;
  from: number;
  to: number;
  risk: MigrationRisk;
}

/** Plugin nodes stored below their definition's version that have a migration path. */
export function pluginNodesBehind(
  graph: WorkflowGraph,
  registry: NodeRegistry,
): PluginNodeBehind[] {
  const out: PluginNodeBehind[] = [];
  for (const n of graph.nodes) {
    const def = registry.get(n.type)?.def;
    if (!def || !isRemoteDefinition(def) || n.typeVersion >= def.version) continue;
    const steps = migrationPath(def, n.typeVersion);
    if (steps === null) continue;
    out.push({
      nodeId: n.id,
      type: n.type,
      from: n.typeVersion,
      to: def.version,
      risk: steps.some((s) => s.risk !== 'safe') ? 'behaviour' : 'safe',
    });
  }
  return out;
}

/**
 * Rewrites the plugin nodes `pluginNodesBehind` lists (limited to `only` types when given)
 * through the plugin host's `migrate`. Whole-graph atomic like `planNodeUpgrades`: a plugin node
 * with no path makes the plan `broken`. A throwing `migrate` propagates; so does a result core
 * cannot accept (settings the node's schema rejects, or over 256 KB).
 */
export async function applyPluginUpgrades(
  graph: WorkflowGraph,
  registry: NodeRegistry,
  migrate: (nodeType: string, from: number, settings: JsonValue) => Promise<JsonValue>,
  only?: ReadonlySet<string>,
): Promise<UpgradePlan> {
  const nodes = [...graph.nodes];
  const broken: string[] = [];
  const todo: number[] = [];
  nodes.forEach((n, index) => {
    const def = registry.get(n.type)?.def;
    if (!def || !isRemoteDefinition(def) || n.typeVersion >= def.version) return;
    if (only && !only.has(n.type)) return;
    if (migrationPath(def, n.typeVersion) === null) broken.push(n.id);
    else todo.push(index);
  });
  if (broken.length > 0) return { kind: 'broken', nodeIds: broken };
  if (todo.length === 0) return { kind: 'current' };
  const notes: string[] = [];
  let risk: MigrationRisk = 'safe';
  for (const index of todo) {
    const original = nodes[index] as NodeInstance;
    const def = registry.get(original.type)?.def as AnyNodeDefinition;
    const steps = migrationPath(def, original.typeVersion) as NodeMigration[];
    const settings = await migrate(original.type, original.typeVersion, original.settings);
    if (JSON.stringify(settings).length > MAX_MIGRATED_BYTES) {
      throw new Error(`migrated settings of ${original.type} are larger than 256 KB`);
    }
    const parsed = parseSettings(def, settings);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      throw new Error(
        `migrated settings of ${original.type} are not valid for v${def.version}${first ? `: ${first.path ? `${first.path}: ` : ''}${first.message}` : ''}`,
      );
    }
    nodes[index] = { ...original, typeVersion: def.version, settings };
    const behaviourNotes = steps.filter((s) => s.risk !== 'safe').map((s) => ` (${s.note})`);
    if (behaviourNotes.length > 0) risk = 'behaviour';
    notes.push(
      `Updated ${def.title} ${original.typeVersion}→${def.version}${behaviourNotes.join('')}`,
    );
  }
  return { kind: 'upgraded', graph: { ...graph, nodes }, risk, notes };
}

/** JSON with object keys sorted, so key order does not affect equality. */
export function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Sorted endpoint keys, duplicates kept, so parallel edges count (multiset). */
function edgeKeys(graph: WorkflowGraph): string[] {
  return graph.edges
    .map((e) => JSON.stringify([e.from.node, e.from.port, e.to.node, e.to.port]))
    .sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * An override survives a re-pin unchanged only if its target node keeps type and typeVersion
 * and its setting key still exists in the new node's settings schema.
 */
function overridesSurvive(
  oldChild: WorkflowGraph,
  newChild: WorkflowGraph,
  overrides: Record<string, JsonValue>,
  registry: NodeRegistry,
): boolean {
  return Object.keys(overrides).every((key) => {
    const parts = splitOverrideKey(key);
    if (!parts) return false;
    const oldNode = oldChild.nodes.find((n) => n.id === parts.nodeId);
    const newNode = newChild.nodes.find((n) => n.id === parts.nodeId);
    if (!oldNode || !newNode) return false;
    if (oldNode.type !== newNode.type || oldNode.typeVersion !== newNode.typeVersion) return false;
    return isKnownOverrideKey(key, newChild, registry);
  });
}

function nodeChangeIsSafe(
  oldNode: NodeInstance,
  newNode: NodeInstance,
  registry: NodeRegistry,
): boolean {
  if (oldNode.type !== newNode.type) return false;
  // Bypass changes what happens to files, so it is not cosmetic (design: anything else is behaviour).
  if ((oldNode.bypassed ?? false) !== (newNode.bypassed ?? false)) return false;
  const newSettings = stableStringify(newNode.settings);
  if (oldNode.typeVersion === newNode.typeVersion) {
    return stableStringify(oldNode.settings) === newSettings;
  }
  if (newNode.typeVersion < oldNode.typeVersion) return false;
  const def = registry.get(oldNode.type)?.def;
  if (!def) return false;
  const steps = chainBetween(def, oldNode.typeVersion, newNode.typeVersion);
  if (steps === null || steps.some((s) => s.risk !== 'safe')) return false;
  try {
    return stableStringify(applySteps(oldNode.settings, steps)) === newSettings;
  } catch {
    return false; // a migration that cannot run proves nothing
  }
}

/**
 * Verdict for re-pinning a Run sub-workflow node from `oldChild` to `newChild`. 'safe' only
 * when the graphs differ in positions, labels and groups, or in node versions whose
 * migrations between the two versions are all safe and reproduce the new settings exactly,
 * and every key in the Run node's `overrides` (`<nodeId>.<settingKey>`) targets a node whose
 * type and typeVersion are unchanged and whose new settings schema still has that key.
 */
export function comparePinChange(
  oldChild: WorkflowGraph,
  newChild: WorkflowGraph,
  overrides: Record<string, JsonValue>,
  registry: NodeRegistry,
): MigrationRisk {
  if (oldChild.kind !== newChild.kind) return 'behaviour';
  if (oldChild.nodes.length !== newChild.nodes.length) return 'behaviour';
  const newById = new Map(newChild.nodes.map((n) => [n.id, n]));
  if (newById.size !== newChild.nodes.length) return 'behaviour';
  const oldIds = new Set(oldChild.nodes.map((n) => n.id));
  if (oldIds.size !== oldChild.nodes.length) return 'behaviour';
  for (const oldNode of oldChild.nodes) {
    const newNode = newById.get(oldNode.id);
    if (!newNode || !nodeChangeIsSafe(oldNode, newNode, registry)) return 'behaviour';
  }
  if (!sameList(edgeKeys(oldChild), edgeKeys(newChild))) return 'behaviour';
  if (!overridesSurvive(oldChild, newChild, overrides, registry)) return 'behaviour';
  return 'safe';
}
