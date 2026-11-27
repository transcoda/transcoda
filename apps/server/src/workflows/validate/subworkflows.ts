import type { NodeMigration } from '@transcoda/sdk';
import {
  type Issue,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  type RunSubworkflowSettings,
  RunSubworkflowSettingsSchema,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { NodeRegistry } from '../../nodes/registry.ts';
import { isRemoteDefinition } from '../../nodes/remote.ts';
import { applyOverrides, checkOverrides } from '../subworkflow-settings.ts';
import { applySteps, migrationPath, rekeyEdges, stableStringify } from '../upgrade.ts';
import { error, title, warning } from './issues.ts';
import { behaviourHoldText } from './nodes.ts';
import type {
  ChildProblem,
  NodeState,
  SubworkflowRef,
  Validate,
  ValidationCache,
  ValidationContext,
} from './types.ts';

// Check 6: Run sub-workflow nodes, their pinned children (validated whole), overrides and
// reference cycles; and migrating a pinned version the way the engine loads it.

function runSettings(n: NodeInstance): RunSubworkflowSettings | null {
  if (n.type !== RUN_SUBWORKFLOW_TYPE) return null;
  const parsed = RunSubworkflowSettingsSchema.safeParse(n.settings);
  return parsed.success ? parsed.data : null;
}

/**
 * True when following run nodes from `graph` (by sub-workflow id, across versions) reaches
 * `ctx.self.id` or an id on `stack`. Adds every sub-workflow id reached to `reach`.
 * `cache.clean` memoises, per `${id}@${version}`, the ids reached by a ref already explored
 * without finding a cycle; such a ref closes a cycle later only if one of those ids is `self` or
 * on the stack (the set does not depend on either, so it is shared across validations).
 */
function reachesCycle(
  graph: WorkflowGraph,
  stack: string[],
  ctx: ValidationContext,
  cache: ValidationCache,
  reach: Set<string>,
): boolean {
  const closes = (id: string) => id === ctx.self?.id || stack.includes(id);
  for (const n of graph.nodes) {
    const s = runSettings(n);
    if (!s) continue;
    if (closes(s.subworkflowId)) return true;
    reach.add(s.subworkflowId);
    const key = `${s.subworkflowId}@${s.version}`;
    let below = cache.clean.get(key);
    if (!below) {
      const ref = resolve(ctx, cache, s.subworkflowId, s.version);
      if (!ref) continue;
      below = new Set<string>();
      if (reachesCycle(ref.graph, [...stack, s.subworkflowId], ctx, cache, below)) return true;
      cache.clean.set(key, below);
    } else if ([...below].some(closes)) {
      return true;
    }
    for (const id of below) reach.add(id);
  }
  return false;
}

export function createValidationCache(): ValidationCache {
  return {
    results: new Map(),
    active: new Set(),
    nested: new WeakMap(),
    resolved: new Map(),
    clean: new Map(),
  };
}

/** `ctx.resolveSubworkflow`, memoised in `cache.resolved`. */
function resolve(
  ctx: ValidationContext,
  cache: ValidationCache,
  id: string,
  version: number,
): SubworkflowRef | null {
  const key = `${id}@${version}`;
  if (cache.resolved.has(key)) return cache.resolved.get(key) ?? null;
  const ref = ctx.resolveSubworkflow(id, version);
  cache.resolved.set(key, ref);
  return ref;
}

/** A node `migratePinned` left as stored; `error` null means its migration path has a behaviour step. */
export interface HeldNode {
  nodeId: string;
  title: string;
  /** The stored node version. */
  from: number;
  error: string | null;
  /** Replaces the generic text (a plugin node held for a behaviour step). */
  message?: string;
}

/**
 * A pinned version as the engine loads it: nodes with an all-safe migration path are migrated;
 * a path with a behaviour step (or a migration that throws) is a problem, and such a node is
 * left as stored (`held`, so its NODE_OUTDATED is not reported twice). Nodes without any path
 * are left for validation to report. Used for pinned children and for a job's own version.
 */
export function migratePinned(
  graph: WorkflowGraph,
  registry: NodeRegistry,
): { graph: WorkflowGraph; held: HeldNode[] } {
  const held: HeldNode[] = [];
  const migrated = new Map<string, NodeMigration[]>();
  const nodes = graph.nodes.map((n) => {
    const def = registry.get(n.type)?.def;
    if (!def || n.typeVersion >= def.version) return n;
    // A plugin node is migrated by its host when it runs; with no path validation reports it.
    if (isRemoteDefinition(def)) {
      const path = migrationPath(def, n.typeVersion);
      if (path?.some((st) => st.risk !== 'safe')) {
        const t = title(n, def);
        held.push({
          nodeId: n.id,
          title: t,
          from: n.typeVersion,
          error: null,
          message: behaviourHoldText(t),
        });
      }
      return n;
    }
    const steps = migrationPath(def, n.typeVersion);
    if (steps === null) return n;
    if (steps.some((step) => step.risk !== 'safe')) {
      held.push({ nodeId: n.id, title: title(n, def), from: n.typeVersion, error: null });
      return n;
    }
    try {
      const settings = applySteps(n.settings, steps);
      migrated.set(n.id, steps);
      return { ...n, typeVersion: def.version, settings };
    } catch (err) {
      held.push({
        nodeId: n.id,
        title: title(n, def),
        from: n.typeVersion,
        error: err instanceof Error ? err.message : String(err),
      });
      return n;
    }
  });
  return { graph: { ...graph, nodes, edges: rekeyEdges(graph.edges, migrated) }, held };
}

/** A child issue as a message that stands on its own (settings issues name their node). */
function childMessage(issue: Issue, graph: WorkflowGraph, registry: NodeRegistry): string {
  if (issue.code !== 'INVALID_SETTINGS' || !issue.nodeId) return issue.message;
  const n = graph.nodes.find((x) => x.id === issue.nodeId);
  const name = n ? title(n, registry.get(n.type)?.def) : issue.nodeId;
  return `${name}: ${issue.settingPath ? `${issue.settingPath}: ` : ''}${issue.message}`;
}

/**
 * The errors of a pinned sub-workflow version, validated whole with all-safe migrations and
 * then the Run node's overrides applied (and, recursively, of the sub-workflows it runs).
 * Memoised per `id@version` and overrides; a child already on the recursion stack is skipped (the cycle is reported by
 * `reachesCycle`), as are the child's own reference-cycle errors.
 */
function childProblems(
  s: RunSubworkflowSettings,
  ref: SubworkflowRef,
  ctx: ValidationContext,
  cache: ValidationCache,
  validate: Validate,
): ChildProblem[] {
  const key = `${s.subworkflowId}@${s.version}`;
  const memoKey = `${key}#${stableStringify(s.overrides)}`;
  const hit = cache.results.get(memoKey);
  if (hit) return hit;
  if (cache.active.has(key)) return [];
  cache.active.add(key);
  try {
    // Migrate first: override keys are checked against the current node schemas, so applying
    // them to the stored (older) settings would let a safe rename silently drop them.
    const migrated = migratePinned(ref.graph, ctx.registry);
    const held = new Set(migrated.held.map((h) => h.nodeId));
    const graph = applyOverrides(migrated.graph, s.overrides, ctx.registry);
    const issues = validate(graph, { ...ctx, self: { id: s.subworkflowId }, cache });
    const found: ChildProblem[] = migrated.held.map((h) => ({
      chain: [],
      message:
        h.message ??
        (h.error === null
          ? `${h.title} needs a review; save an upgraded version of the workflow and queue the file again`
          : `${h.title} could not be upgraded: ${h.error}`),
    }));
    for (const issue of issues) {
      if (issue.severity !== 'error' || issue.code === 'SUBWORKFLOW_REFERENCE_CYCLE') continue;
      if (issue.code === 'NODE_OUTDATED' && issue.nodeId && held.has(issue.nodeId)) continue;
      const nested = cache.nested.get(issue);
      found.push(
        nested
          ? { chain: [nested.ref, ...nested.problem.chain], message: nested.problem.message }
          : { chain: [], message: childMessage(issue, graph, ctx.registry) },
      );
    }
    const seen = new Set<string>();
    const unique = found.filter((p) => {
      const k = JSON.stringify(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    cache.results.set(memoKey, unique);
    return unique;
  } finally {
    cache.active.delete(key);
  }
}

/** Check 6: Run sub-workflow references, overrides and reference cycles. */
export function checkSubworkflowRefs(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  ctx: ValidationContext,
  cache: ValidationCache,
  issues: Issue[],
  validate: Validate,
): void {
  for (const n of graph.nodes) {
    const state = states.get(n.id);
    if (state?.status !== 'current' || state.settings === null) continue;
    const s = runSettings(n);
    if (!s) continue;
    const name = title(n, state.def);
    const ref = resolve(ctx, cache, s.subworkflowId, s.version);
    if (!ref) {
      issues.push(
        error(
          'SUBWORKFLOW_MISSING',
          `${name}: sub-workflow ${s.subworkflowId} version ${s.version} does not exist`,
          {
            nodeId: n.id,
          },
        ),
      );
      continue;
    }
    if (s.version < ref.currentVersion) {
      issues.push(
        warning(
          'SUBWORKFLOW_OUTDATED',
          `${name} uses version ${s.version}; the latest is ${ref.currentVersion}`,
          {
            nodeId: n.id,
          },
        ),
      );
    }
    const overrides = checkOverrides(s.overrides, ref.graph, ctx.registry);
    for (const key of overrides.unknownKeys) {
      issues.push(
        warning(
          'OVERRIDE_DROPPED',
          `${name}: override ${key} no longer exists and will be dropped`,
          {
            nodeId: n.id,
            settingPath: `overrides.${key}`,
          },
        ),
      );
    }
    for (const { key, message } of overrides.invalid) {
      issues.push(
        error('INVALID_OVERRIDE', `${name}: override ${key}: ${message}`, {
          nodeId: n.id,
          settingPath: `overrides.${key}`,
        }),
      );
    }
    const pinned = `${s.subworkflowId} version ${s.version}`;
    // Invalid overrides are reported above; the child is checked with the valid ones only.
    const invalidKeys = new Set(overrides.invalid.map((i) => i.key));
    const applied = Object.fromEntries(
      Object.entries(s.overrides).filter(([key]) => !invalidKeys.has(key)),
    );
    for (const problem of childProblems({ ...s, overrides: applied }, ref, ctx, cache, validate)) {
      const chain = problem.chain.map((c) => ` → ${c}`).join('');
      const issue = error(
        'SUBWORKFLOW_BROKEN',
        `${name}: sub-workflow ${pinned}${chain}: ${problem.message}`,
        { nodeId: n.id },
      );
      cache.nested.set(issue, { ref: pinned, problem });
      issues.push(issue);
    }
    const cyclic =
      s.subworkflowId === ctx.self?.id ||
      reachesCycle(ref.graph, [s.subworkflowId], ctx, cache, new Set());
    if (cyclic) {
      issues.push(
        error(
          'SUBWORKFLOW_REFERENCE_CYCLE',
          `${name}: sub-workflow ${s.subworkflowId} calls itself`,
          {
            nodeId: n.id,
          },
        ),
      );
    }
  }
}
