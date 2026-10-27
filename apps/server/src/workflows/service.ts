import { randomUUID } from 'node:crypto';
import type {
  Capabilities,
  LibraryRef,
  NodeInfo,
  WorkflowActive,
  WorkflowDetail,
  WorkflowRef,
  WorkflowSaveOutput,
  WorkflowSummary,
  WorkflowVersionInfo,
} from '@transcoda/contract';
import { nodeMetadata } from '@transcoda/sdk';
import {
  emptyGraph,
  FORMAT_VERSION,
  hasErrors,
  type Issue,
  type JsonValue,
  libraryInputOf,
  RENDER_TYPE,
  RUN_SUBWORKFLOW_TYPE,
  type RunSubworkflowSettings,
  RunSubworkflowSettingsSchema,
  syncLinkedSettings,
  upgradeGraphJson,
  type WorkflowGraph,
  type WorkflowGraphInput,
  WorkflowGraphSchema,
  type WorkflowKind,
} from '@transcoda/shared';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import { findLibrary, listLibraries } from '../db/repos/libraries.ts';
import {
  appendVersion,
  clearActiveVersion,
  findFeeder,
  findVersion,
  findWorkflow,
  type GraphUpgrade,
  insertWorkflow,
  listCurrentVersions,
  listVersions,
  NotFoundError,
  renameWorkflow,
  type StoredVersion,
  setActiveVersion,
  softDeleteWorkflow,
  VersionConflictError,
  type WorkflowRow,
} from '../db/repos/workflows.ts';
import type { Logger } from '../logger.ts';
import { nodeAvailability } from '../nodes/availability.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import { applyOverrides, dropStaleOverrides, subworkflowSettings } from './subworkflow-settings.ts';
import { applyPluginUpgrades, comparePinChange, planNodeUpgrades } from './upgrade.ts';
import {
  createValidationCache,
  migratePinned,
  type SubworkflowRef,
  type ValidationCache,
  type ValidationContext,
  validateWorkflow,
} from './validate.ts';
import { dropWebhookUrls } from './webhook-urls.ts';

export interface WorkflowServiceDeps {
  db: Database;
  registry: NodeRegistry;
  capabilities: () => Capabilities;
  now: () => Date;
  log: Logger;
  /** Server settings validation depends on; defaults to no output roots. */
  config?: Pick<Config, 'outputRoots'>;
}

export class CorruptGraphError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly version: number,
    detail: string,
  ) {
    super(`Workflow ${workflowId} version ${version} could not be read: ${detail}`);
    this.name = 'CorruptGraphError';
  }
}

export class KindMismatchError extends Error {
  constructor(
    public readonly expected: WorkflowKind,
    public readonly actual: WorkflowKind,
  ) {
    super(`Graph kind ${actual} does not match the workflow kind ${expected}`);
    this.name = 'KindMismatchError';
  }
}

/** behaviour ⊆ upgraded; upgraded + broken + unchanged = live workflows. */
export interface UpgradeSummary {
  upgraded: number;
  behaviour: number;
  broken: number;
  unchanged: number;
}

/** A workflow version loaded for a job: migrated (all-safe paths only) and valid. */
export interface LoadedForRun {
  kind: 'ok';
  graph: WorkflowGraph;
  /** The workflow's active version at load time; null when not active. */
  activeVersion: number | null;
}

type CurrentEntry = {
  workflow: WorkflowRow;
  version: StoredVersion;
  /** The active version's row when it differs from the current one. */
  active: StoredVersion | null;
};

/** The current versions of all live workflows, with the references between them. */
interface CurrentIndex {
  byId: Map<string, CurrentEntry>;
  /** Sub-workflow id → live workflows whose current graph runs it, sorted by name. */
  usedBy: Map<string, WorkflowRef[]>;
  /** Live library id → name. */
  libraries: Map<string, string>;
}

function runSettings(n: WorkflowGraph['nodes'][number]): RunSubworkflowSettings | null {
  if (n.type !== RUN_SUBWORKFLOW_TYPE) return null;
  const parsed = RunSubworkflowSettingsSchema.safeParse(n.settings);
  return parsed.success ? parsed.data : null;
}

function corruptIssue(workflowId: string, version: number): Issue {
  return {
    severity: 'error',
    code: 'CORRUPT_GRAPH',
    message: `The stored graph of ${workflowId} version ${version} could not be read`,
  };
}

/** better-sqlite3's error for a UNIQUE index violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A deep copy of plain data, frozen at every level. */
function deepFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const child of Object.values(v)) freeze(child);
  };
  freeze(copy);
  return copy;
}

function byName(a: WorkflowRef, b: WorkflowRef): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The version note of a version `upgradeAll` writes to bring a stored graph to format 2. */
export const FORMAT_2_NOTE = 'Added a Render step before the finish steps (graph format 2)';

/**
 * The read upgrade for stored and incoming graphs: format 1 → 2 with Render inserted on the file
 * edges into the finish nodes the registry knows (a node of an unknown type is never taken for
 * one; data edges never get a Render).
 */
export function graphUpgrade(registry: NodeRegistry): GraphUpgrade {
  return (raw) => upgradeGraphJson(raw, (type) => registry.get(type)?.def);
}

export class WorkflowService {
  private readonly warnedNoPath = new Set<string>();
  private readonly upgradeJson: GraphUpgrade;
  constructor(private readonly deps: WorkflowServiceDeps) {
    this.upgradeJson = graphUpgrade(deps.registry);
  }

  /**
   * A graph the API or MCP accepted (format 1 or 2) at the current format: a format-1 graph gets
   * its Render nodes as a stored one would. Throws when the result is not a valid graph (a format-1
   * graph at the node or edge limit).
   */
  upgradeInput(graph: WorkflowGraphInput): WorkflowGraph {
    if (graph.formatVersion === FORMAT_VERSION) return graph as WorkflowGraph;
    return WorkflowGraphSchema.parse(this.upgradeJson(graph));
  }

  /** Node metadata, rebuilt only when the registry's generation changes (a plugin added or removed). */
  private metadata?: { generation: number; nodes: Omit<NodeInfo, 'availability'>[] };

  listNodes(): NodeInfo[] {
    const { registry } = this.deps;
    if (this.metadata?.generation !== registry.generation) {
      this.metadata = {
        generation: registry.generation,
        nodes: registry.list().map(({ def, source }) => {
          // nodeMetadata returns a remote definition's own settings schema verbatim.
          const m = nodeMetadata(def);
          // A frozen copy: callers share it, and the inputs/outputs arrays are the definition's own.
          return deepFreeze({
            type: m.type,
            version: m.version,
            kind: m.kind,
            title: m.title,
            description: m.description,
            icon: m.icon,
            inputs: m.inputs,
            outputs: m.outputs,
            settingsSchema: m.settingsSchema,
            onNodeSettings: m.onNodeSettings,
            finishPhase: m.finishPhase,
            damagedOnly: m.damagedOnly,
            source,
          });
        }),
      };
    }
    // Availability is recomputed per call: capabilities are a function and a plugin may stop.
    const caps = this.deps.capabilities();
    const env = { outputRoots: this.outputRoots() };
    return this.metadata.nodes.flatMap((info) => {
      // undefined only if a plugin was removed after the cache was built (generation moved on); skip it.
      const entry = registry.get(info.type);
      return entry ? [{ ...info, availability: nodeAvailability(entry, caps, env) }] : [];
    });
  }

  /**
   * Live workflows whose current or active graph uses any of `types` (for remove/disable
   * confirmations), by name. `active`: the workflow's active version uses one, so it would stop
   * being runnable. Run nodes are followed into their pinned child versions, so a parent is listed too.
   * Corrupt versions are skipped.
   */
  workflowsUsingNodeTypes(types: string[]): Array<WorkflowRef & { active: boolean }> {
    const wanted = new Set(types);
    // A graph reaches a type directly or through a Run node's pinned child (the exact pinned
    // version, as the engine runs it). `visiting` stops a cycle of pins.
    const reaches = (graph: WorkflowGraph, visiting: Set<string>): boolean =>
      graph.nodes.some((n) => {
        if (wanted.has(n.type)) return true;
        const s = runSettings(n);
        if (!s) return false;
        const key = `${s.subworkflowId}@${s.version}`;
        if (visiting.has(key)) return false;
        const child = this.resolveSubworkflow(s.subworkflowId, s.version);
        return !!child && reaches(child.graph, new Set(visiting).add(key));
      });
    const uses = (v: StoredVersion | null | undefined): boolean =>
      !!v?.ok && reaches(v.row.graph, new Set());
    const out: Array<WorkflowRef & { active: boolean }> = [];
    for (const { workflow, version, active } of this.index().byId.values()) {
      // `active` is only set when the active version differs from the current one.
      const activeRow = workflow.activeVersion === null ? null : (active ?? version);
      const isActive = uses(activeRow);
      if (isActive || uses(version))
        out.push({ id: workflow.id, name: workflow.name, active: isActive });
    }
    return out.sort(byName);
  }

  /**
   * The node types each live workflow's current and active graphs use (`types`) and those its
   * active version uses (`activeTypes`, empty when none is active), Run nodes followed into their
   * pinned child versions; by workflow name. One pass serves the whole plugin list (what each
   * plugin is used by, and the plugins workflows miss). Corrupt versions are skipped.
   */
  nodeTypesInUse(): Array<{ workflow: WorkflowRef; types: string[]; activeTypes: string[] }> {
    const collect = (graph: WorkflowGraph, visiting: Set<string>, out: Set<string>): void => {
      for (const n of graph.nodes) {
        out.add(n.type);
        const s = runSettings(n);
        if (!s) continue;
        const key = `${s.subworkflowId}@${s.version}`;
        if (visiting.has(key)) continue;
        const child = this.resolveSubworkflow(s.subworkflowId, s.version);
        if (child) collect(child.graph, new Set(visiting).add(key), out);
      }
    };
    const typesOf = (v: StoredVersion | null | undefined): Set<string> => {
      const out = new Set<string>();
      if (v?.ok) collect(v.row.graph, new Set(), out);
      return out;
    };
    const out: Array<{ workflow: WorkflowRef; types: string[]; activeTypes: string[] }> = [];
    for (const { workflow, version, active } of this.index().byId.values()) {
      // `active` is only set when the active version differs from the current one.
      const activeRow = workflow.activeVersion === null ? null : (active ?? version);
      const current = typesOf(version);
      const activeTypes = activeRow === version ? current : typesOf(activeRow);
      const types = new Set([...current, ...activeTypes]);
      if (types.size > 0) {
        out.push({
          workflow: { id: workflow.id, name: workflow.name },
          types: [...types],
          activeTypes: [...activeTypes],
        });
      }
    }
    return out.sort((a, b) => byName(a.workflow, b.workflow));
  }

  /**
   * The nodes of `types` each live workflow's graphs hold, for the plugin update pre-check: one
   * entry per (workflow, graph), the current graph and, when it differs, the active one
   * (`active: true`; the current entry is `active` only when it is also the active version). Run
   * nodes are followed into their pinned child versions. Corrupt versions are skipped.
   */
  pinnedNodes(types: string[]): Array<{
    workflow: WorkflowRef;
    active: boolean;
    version: number;
    nodes: Array<{ type: string; typeVersion: number }>;
  }> {
    const wanted = new Set(types);
    const collect = (
      graph: WorkflowGraph,
      visiting: Set<string>,
      out: Array<{ type: string; typeVersion: number }>,
    ): void => {
      for (const n of graph.nodes) {
        if (wanted.has(n.type)) out.push({ type: n.type, typeVersion: n.typeVersion });
        const s = runSettings(n);
        if (!s) continue;
        const key = `${s.subworkflowId}@${s.version}`;
        if (visiting.has(key)) continue;
        const child = this.resolveSubworkflow(s.subworkflowId, s.version);
        if (child) collect(child.graph, new Set(visiting).add(key), out);
      }
    };
    const out: ReturnType<WorkflowService['pinnedNodes']> = [];
    for (const { workflow, version, active } of this.index().byId.values()) {
      const ref = { id: workflow.id, name: workflow.name };
      const activeRow = workflow.activeVersion === null ? null : (active ?? version);
      const entries: Array<[StoredVersion, number, boolean]> = [
        [version, workflow.currentVersion, activeRow === version],
      ];
      if (active && workflow.activeVersion !== null)
        entries.push([active, workflow.activeVersion, true]);
      for (const [stored, number, isActive] of entries) {
        if (!stored.ok) continue;
        const nodes: Array<{ type: string; typeVersion: number }> = [];
        collect(stored.row.graph, new Set(), nodes);
        if (nodes.length > 0) out.push({ workflow: ref, active: isActive, version: number, nodes });
      }
    }
    return out.sort((a, b) => byName(a.workflow, b.workflow) || a.version - b.version);
  }

  list(): WorkflowSummary[] {
    const index = this.index();
    // One cache for the whole listing: a sub-workflow pinned by many parents is validated once.
    const cache = createValidationCache();
    return [...index.byId.values()].map((entry) => this.currentSummary(entry, index, cache));
  }

  get(id: string, version?: number): WorkflowDetail | null {
    const workflow = findWorkflow(this.deps.db, id);
    if (!workflow) return null;
    const v = version ?? workflow.currentVersion;
    const stored = findVersion(this.deps.db, id, v, this.upgradeJson);
    if (!stored && version === undefined) {
      throw new CorruptGraphError(id, v, `Stored version ${v} is missing`);
    }
    if (!stored) return null;
    if (!stored.ok) throw new CorruptGraphError(id, v, stored.error);
    // An older version is shown as the engine would run it (safe migrations and their edge
    // re-keying applied), so its edges and ports match the current node definitions.
    const graph =
      v === workflow.currentVersion
        ? stored.row.graph
        : migratePinned(stored.row.graph, this.deps.registry).graph;
    const issues = this.issuesFor(graph, id);
    const active = this.activeState(workflow);
    return {
      ...this.summary(workflow, graph, issues, this.index(), active.active),
      version: v,
      graph,
      issues,
      activeIssues: active.issues,
      settings:
        workflow.kind === 'subworkflow' ? subworkflowSettings(graph, this.deps.registry) : null,
    };
  }

  /** Throws KindMismatchError when `graph` is of the other kind. */
  create(
    input: {
      name: string;
      kind: WorkflowKind;
      graph?: WorkflowGraphInput | undefined;
      note?: string | undefined;
    },
    createdBy: string,
  ): WorkflowDetail {
    const graph = input.graph ? this.upgradeInput(input.graph) : emptyGraph(input.kind);
    if (graph.kind !== input.kind) throw new KindMismatchError(input.kind, graph.kind);
    const row = insertWorkflow(
      this.deps.db,
      {
        id: randomUUID(),
        kind: input.kind,
        name: input.name,
        graph,
        createdBy,
        note: input.note || null,
      },
      this.deps.now(),
    );
    return this.get(row.id) as WorkflowDetail;
  }

  /**
   * The current version of `id` copied as a new, not active workflow of the same kind under `name`,
   * without webhook URLs (`droppedNodeIds` names the nodes that need new ones).
   * Throws CorruptGraphError when the current version cannot be read.
   */
  duplicate(
    id: string,
    name: string,
    createdBy: string,
    note?: string,
  ):
    | { kind: 'ok'; detail: WorkflowDetail; sourceVersion: number; droppedNodeIds: string[] }
    | { kind: 'not-found' } {
    const source = this.get(id);
    if (!source) return { kind: 'not-found' };
    const { graph, droppedNodeIds } = dropWebhookUrls(source.graph);
    const detail = this.create({ name, kind: source.kind, graph, note }, createdBy);
    return { kind: 'ok', detail, sourceVersion: source.version, droppedNodeIds };
  }

  /**
   * Adds a version; never reads or writes the active pointer (a save does not change what runs).
   * `restoredFrom` marks a restore: its graph is upgraded to the registered node versions first.
   * Throws NotFoundError, KindMismatchError, VersionConflictError.
   */
  save(
    input: {
      id: string;
      baseVersion: number;
      graph: WorkflowGraphInput;
      note?: string | undefined;
      restoredFrom?: number | undefined;
    },
    createdBy: string,
  ): WorkflowSaveOutput {
    const { db, registry } = this.deps;
    const workflow = findWorkflow(db, input.id);
    if (!workflow) throw new NotFoundError(`Workflow ${input.id} not found`);
    if (input.graph.kind !== workflow.kind) {
      throw new KindMismatchError(workflow.kind, input.graph.kind);
    }
    if (workflow.currentVersion !== input.baseVersion) {
      throw new VersionConflictError(workflow.currentVersion);
    }

    const changes: string[] = [];
    // The settings hold what runs: a linked setting takes its shared value's current copy.
    let sent = syncLinkedSettings(this.upgradeInput(input.graph));
    let note = input.note || null;
    if (input.restoredFrom !== undefined) {
      const upgraded = this.upgradeRestored(sent);
      if (upgraded.kind === 'upgraded') {
        sent = upgraded.graph;
        changes.push(...upgraded.notes);
        note = [input.note, ...upgraded.notes].filter(Boolean).join('; ') || null;
      } else if (upgraded.kind === 'broken') {
        changes.push(`Could not upgrade: ${upgraded.detail}`);
      }
    }

    const resolveGraph = (id: string, v: number) => this.resolveSubworkflow(id, v)?.graph ?? null;
    const { graph, dropped } = dropStaleOverrides(sent, resolveGraph, registry);

    const base = findVersion(db, input.id, input.baseVersion, this.upgradeJson);
    if (!base?.ok) changes.push(`Previous version ${input.baseVersion} could not be read`);
    const baseNodes = base?.ok ? base.row.graph.nodes : [];
    const baseRuns = new Map(
      baseNodes.filter((n) => n.type === RUN_SUBWORKFLOW_TYPE).map((n) => [n.id, n]),
    );
    for (const n of graph.nodes) {
      const oldNode = n.type === RUN_SUBWORKFLOW_TYPE ? baseRuns.get(n.id) : undefined;
      if (!oldNode) continue;
      const change = this.pinChange(runSettings(oldNode), runSettings(n));
      if (change) changes.push(change);
    }
    if (dropped.length > 0) {
      changes.push(
        `Dropped overrides that no longer exist: ${dropped.map((d) => d.key).join(', ')}`,
      );
    }
    // Errors are a draft's right: the version is stored whatever its issues are.
    const issues = this.issuesFor(graph, input.id);
    const row = appendVersion(
      db,
      {
        workflowId: input.id,
        baseVersion: input.baseVersion,
        graph,
        note,
        createdBy,
      },
      this.deps.now(),
    );
    return {
      version: row.version,
      issues,
      valid: !hasErrors(issues),
      active: this.summaryOf(input.id)?.active ?? null,
      changes,
    };
  }

  validate(graph: WorkflowGraphInput, selfId?: string): { issues: Issue[]; valid: boolean } {
    const issues = this.issuesFor(this.upgradeInput(graph), selfId);
    return { issues, valid: !hasErrors(issues) };
  }

  /**
   * The active pointer of a live workflow of kind 'workflow'; 'missing' when it is deleted,
   * unknown or a sub-workflow.
   */
  activeVersionOf(id: string): number | null | 'missing' {
    const workflow = findWorkflow(this.deps.db, id);
    return workflow?.kind === 'workflow' ? workflow.activeVersion : 'missing';
  }

  /**
   * Real runs use `version` from now on; the same version again is a no-op. A version with a
   * Library input binds the workflow to that library: refused when the library is not live
   * (`library-missing`) or another active workflow already takes its files (`library-taken`).
   */
  activate(
    id: string,
    version: number,
    activatedBy: string,
  ):
    | { kind: 'ok'; summary: WorkflowSummary }
    | { kind: 'not-found'; what: 'workflow' | 'version' }
    | { kind: 'kind-mismatch' }
    | { kind: 'invalid'; issues: Issue[] }
    | { kind: 'library-missing'; libraryId: string }
    | {
        kind: 'library-taken';
        library: LibraryRef;
        workflow: { id: string; name: string; version: number };
      } {
    const { db } = this.deps;
    const workflow = findWorkflow(db, id);
    if (!workflow) return { kind: 'not-found', what: 'workflow' };
    if (workflow.kind === 'subworkflow') return { kind: 'kind-mismatch' };
    if (!findVersion(db, id, version, this.upgradeJson))
      return { kind: 'not-found', what: 'version' };
    // The same check a real run makes when it loads the version.
    const loaded = this.loadForRun(id, version);
    if (loaded.kind === 'invalid') return { kind: 'invalid', issues: loaded.issues };
    if (loaded.kind === 'missing') return { kind: 'not-found', what: 'version' };
    // An empty id is INVALID_SETTINGS, which loadForRun already refused.
    const libraryId = libraryInputOf(loaded.graph)?.libraryId || null;
    let library: LibraryRef | null = null;
    if (libraryId !== null) {
      const row = findLibrary(db, libraryId);
      if (!row || row.deletedAt !== null) return { kind: 'library-missing', libraryId };
      library = { id: row.id, name: row.name };
    }
    // The feeder's own row is never "another active workflow" (re-activation, rollback).
    const taken = (lib: LibraryRef) => {
      const feeder = findFeeder(db, lib.id);
      return feeder && feeder.workflowId !== id
        ? {
            kind: 'library-taken' as const,
            library: lib,
            workflow: { id: feeder.workflowId, name: feeder.name, version: feeder.version },
          }
        : null;
    };
    if (library) {
      const refused = taken(library);
      if (refused) return refused;
    }
    if (workflow.activeVersion !== version || workflow.activeLibraryId !== libraryId) {
      try {
        setActiveVersion(db, id, version, activatedBy, this.deps.now(), libraryId);
      } catch (err) {
        if (err instanceof NotFoundError) return { kind: 'not-found', what: 'version' };
        // A concurrent activation bound the library first (the unique index on the column).
        if (library && isUniqueViolation(err)) {
          const refused = taken(library);
          if (refused) return refused;
        }
        throw err;
      }
    }
    const summary = this.summaryOf(id);
    return summary ? { kind: 'ok', summary } : { kind: 'not-found', what: 'workflow' };
  }

  /** Real runs stop until a version is activated; ok when nothing was active. */
  deactivate(
    id: string,
  ): { kind: 'ok'; summary: WorkflowSummary } | { kind: 'not-found' } | { kind: 'kind-mismatch' } {
    const workflow = findWorkflow(this.deps.db, id);
    if (!workflow) return { kind: 'not-found' };
    if (workflow.kind === 'subworkflow') return { kind: 'kind-mismatch' };
    clearActiveVersion(this.deps.db, id);
    const summary = this.summaryOf(id);
    return summary ? { kind: 'ok', summary } : { kind: 'not-found' };
  }

  rename(id: string, name: string): WorkflowSummary | null {
    if (!renameWorkflow(this.deps.db, id, name, this.deps.now())) return null;
    return this.summaryOf(id);
  }

  delete(
    id: string,
  ): { kind: 'ok' } | { kind: 'not-found' } | { kind: 'in-use'; usedBy: WorkflowRef[] } {
    const workflow = findWorkflow(this.deps.db, id);
    if (!workflow) return { kind: 'not-found' };
    const index = this.index();
    const usedBy = [...(index.usedBy.get(id) ?? [])];
    if (workflow.kind === 'subworkflow') {
      // A parent whose current or active graph cannot be parsed may still run this sub-workflow:
      // conservatively count it as a user when its stored text mentions the id.
      for (const { workflow: parent, version, active } of index.byId.values()) {
        if (parent.id === id) continue;
        const unreadable = [version, active].some((v) => v && !v.ok && v.raw?.includes(id));
        if (unreadable) usedBy.push({ id: parent.id, name: parent.name });
      }
      usedBy.sort(byName);
    }
    if (usedBy.length > 0) return { kind: 'in-use', usedBy };
    return softDeleteWorkflow(this.deps.db, id, this.deps.now())
      ? { kind: 'ok' }
      : { kind: 'not-found' };
  }

  /**
   * The workflow's stored graphs as saved (not migrated), `first` versions first, then every other
   * version newest first; versions that cannot be read are skipped. Lazy: each is read from the
   * database only when iterated to (the redacted-URL lookup usually stops at the first).
   */
  *storedGraphs(id: string, first: readonly number[]): Generator<WorkflowGraph> {
    const { db } = this.deps;
    const seen = new Set<number>();
    const read = (v: number): WorkflowGraph | null => {
      if (seen.has(v)) return null;
      seen.add(v);
      const stored = findVersion(db, id, v, this.upgradeJson);
      return stored?.ok ? stored.row.graph : null;
    };
    for (const v of first) {
      const g = read(v);
      if (g) yield g;
    }
    for (const { version } of listVersions(db, id)) {
      const g = read(version);
      if (g) yield g;
    }
  }

  versions(id: string): WorkflowVersionInfo[] | null {
    if (!findWorkflow(this.deps.db, id)) return null;
    return listVersions(this.deps.db, id).map(({ version, note, createdBy, createdAt }) => ({
      version,
      note,
      createdBy,
      createdAt,
    }));
  }

  /**
   * Migrates every live workflow's current version to the registered node versions and the
   * current graph format (a format-1 version gets its Render nodes, `FORMAT_2_NOTE`). Never
   * throws for a single workflow: a corrupt graph, a node without a migration path or a
   * failing migration (or one whose output is not a valid graph) leaves that workflow unchanged
   * and counts it as broken. If the workflows cannot be listed at all, one error is logged and
   * the empty summary returned.
   */
  upgradeAll(): UpgradeSummary {
    const { db, registry, log } = this.deps;
    const summary: UpgradeSummary = { upgraded: 0, behaviour: 0, broken: 0, unchanged: 0 };
    let current: ReturnType<typeof listCurrentVersions>;
    try {
      current = listCurrentVersions(db, this.upgradeJson);
    } catch (err) {
      log.error({
        msg: 'workflow upgrades failed: could not list workflows',
        error: errorMessage(err),
      });
      return summary;
    }
    for (const { workflow, version } of current) {
      const workflowId = workflow.id;
      try {
        if (!version.ok) {
          summary.broken++;
          log.warn({
            msg: 'workflow upgrade skipped: corrupt graph',
            workflowId,
            version: version.version,
            error: version.error,
          });
          continue;
        }
        // A format-1 row was upgraded on read; the format upgrade is written with the node
        // upgrades. Not while a node type is unknown (a plugin that is not installed): the read
        // could not tell whether it is a finish node, so the row stays at format 1 and is
        // upgraded again on every read until the plugin is back.
        const format =
          version.row.formatVersion < FORMAT_VERSION &&
          version.row.graph.nodes.every(
            (n) => n.type === RENDER_TYPE || registry.get(n.type) !== undefined,
          );
        const plan = planNodeUpgrades(version.row.graph, registry);
        if (plan.kind === 'current' && !format) {
          summary.unchanged++;
          continue;
        }
        if (plan.kind === 'broken') {
          summary.broken++;
          log.warn({
            msg: 'workflow upgrade skipped: no migration path',
            workflowId,
            nodeIds: plan.nodeIds,
          });
          continue;
        }
        // A migration may return anything: only a valid graph is written.
        const parsed = WorkflowGraphSchema.safeParse(
          plan.kind === 'current' ? version.row.graph : plan.graph,
        );
        if (!parsed.success) {
          summary.broken++;
          log.warn({ msg: 'workflow upgrade failed', workflowId, error: parsed.error.message });
          continue;
        }
        const notes = plan.kind === 'current' ? [] : plan.notes;
        const note = [...(format ? [FORMAT_2_NOTE] : []), ...notes].join('; ');
        const behaviour = plan.kind === 'upgraded' && plan.risk === 'behaviour';
        // Only the newest version is upgraded; the active pointer is never touched.
        appendVersion(
          db,
          {
            workflowId,
            baseVersion: workflow.currentVersion,
            graph: parsed.data,
            note,
            createdBy: 'system:upgrade',
          },
          this.deps.now(),
        );
        summary.upgraded++;
        if (behaviour) summary.behaviour++;
      } catch (err) {
        summary.broken++;
        log.warn({ msg: 'workflow upgrade failed', workflowId, error: errorMessage(err) });
      }
    }
    log.info(
      `workflow upgrades: ${summary.upgraded} upgraded (${summary.behaviour} with behaviour changes), ${summary.broken} broken, ${summary.unchanged} unchanged`,
    );
    return summary;
  }

  /**
   * Brings the plugin nodes of `types` in every live workflow's current version up to the
   * plugin's node versions, through the plugin host (`migrate`), after the plugin is installed,
   * updated, enabled or started. Like `upgradeAll` it never throws for a single workflow and
   * never touches the active pointer: a new version is written, and a person activates it.
   */
  async upgradePluginNodes(
    types: string[],
    migrate: (nodeType: string, from: number, settings: JsonValue) => Promise<JsonValue>,
  ): Promise<UpgradeSummary> {
    const { db, registry, log } = this.deps;
    const only = new Set(types);
    const summary: UpgradeSummary = { upgraded: 0, behaviour: 0, broken: 0, unchanged: 0 };
    let current: ReturnType<typeof listCurrentVersions>;
    try {
      current = listCurrentVersions(db, this.upgradeJson);
    } catch (err) {
      log.error({
        msg: 'plugin node upgrades failed: could not list workflows',
        error: errorMessage(err),
      });
      return summary;
    }
    for (const { workflow, version } of current) {
      const workflowId = workflow.id;
      try {
        if (!version.ok) continue;
        const plan = await applyPluginUpgrades(version.row.graph, registry, migrate, only);
        if (plan.kind === 'current') {
          summary.unchanged++;
          continue;
        }
        if (plan.kind === 'broken') {
          summary.broken++;
          // Once per workflow version per process: it would repeat on every start otherwise.
          const warnKey = `${workflowId}@${workflow.currentVersion}`;
          if (!this.warnedNoPath.has(warnKey)) {
            this.warnedNoPath.add(warnKey);
            log.warn({
              msg: 'plugin node upgrade skipped: no migration path',
              workflowId,
              nodeIds: plan.nodeIds,
            });
          }
          continue;
        }
        const parsed = WorkflowGraphSchema.safeParse(plan.graph);
        if (!parsed.success) {
          summary.broken++;
          log.warn({ msg: 'plugin node upgrade failed', workflowId, error: parsed.error.message });
          continue;
        }
        appendVersion(
          db,
          {
            workflowId,
            baseVersion: workflow.currentVersion,
            graph: parsed.data,
            note: plan.notes.join('; '),
            createdBy: 'system:upgrade',
          },
          this.deps.now(),
        );
        summary.upgraded++;
        if (plan.risk === 'behaviour') summary.behaviour++;
      } catch (err) {
        summary.broken++;
        log.warn({ msg: 'plugin node upgrade failed', workflowId, error: errorMessage(err) });
      }
    }
    if (summary.upgraded + summary.broken > 0) {
      log.info(
        `plugin node upgrades: ${summary.upgraded} upgraded (${summary.behaviour} with behaviour changes), ${summary.broken} broken`,
      );
    }
    return summary;
  }

  /**
   * A job's pinned version as the engine runs it: re-read from the database, nodes with an
   * all-safe migration path migrated (the same rule as pinned children), then validated with its
   * children. A node whose path has a behaviour step, or whose migration throws, makes the version
   * invalid (one NODE_OUTDATED on that node). `missing`: the workflow is deleted, not of kind
   * 'workflow', or the version does not exist. `cache` memoises pinned children across calls.
   */
  loadForRun(
    id: string,
    version: number,
    cache?: ValidationCache,
  ): LoadedForRun | { kind: 'invalid'; issues: Issue[] } | { kind: 'missing' } {
    const { db, registry } = this.deps;
    const workflow = findWorkflow(db, id);
    if (workflow?.kind !== 'workflow') return { kind: 'missing' };
    const stored = findVersion(db, id, version, this.upgradeJson);
    if (!stored) return { kind: 'missing' };
    if (!stored.ok) return { kind: 'invalid', issues: [corruptIssue(id, version)] };
    const { graph, held } = migratePinned(stored.row.graph, registry);
    const heldIds = new Set(held.map((h) => h.nodeId));
    const issues: Issue[] = held.map((h) => ({
      severity: 'error',
      code: 'NODE_OUTDATED',
      nodeId: h.nodeId,
      message:
        h.message ??
        (h.error === null
          ? `${h.title} needs a review: its upgrade from version ${h.from} changes behaviour; save an upgraded version of the workflow and queue the file again`
          : `${h.title} could not be upgraded: ${h.error}`),
    }));
    for (const issue of this.issuesFor(graph, id, cache)) {
      // A held node is still outdated; its issue above says why.
      if (issue.code === 'NODE_OUTDATED' && issue.nodeId && heldIds.has(issue.nodeId)) continue;
      issues.push(issue);
    }
    if (hasErrors(issues)) return { kind: 'invalid', issues };
    return { kind: 'ok', graph, activeVersion: workflow.activeVersion };
  }

  /** The node upgrades a restored graph gets (the all-safe and the behaviour paths alike). */
  private upgradeRestored(
    graph: WorkflowGraph,
  ):
    | { kind: 'current' }
    | { kind: 'upgraded'; graph: WorkflowGraph; notes: string[] }
    | { kind: 'broken'; detail: string } {
    try {
      const plan = planNodeUpgrades(graph, this.deps.registry);
      if (plan.kind === 'current') return plan;
      if (plan.kind === 'broken') return { kind: 'broken', detail: plan.nodeIds.join(', ') };
      const parsed = WorkflowGraphSchema.safeParse(plan.graph);
      if (!parsed.success) return { kind: 'broken', detail: 'invalid migration output' };
      return { kind: 'upgraded', graph: parsed.data, notes: plan.notes };
    } catch (err) {
      this.deps.log.warn({
        msg: 'restored version could not be upgraded',
        error: errorMessage(err),
      });
      return { kind: 'broken', detail: 'migration failed' };
    }
  }

  /**
   * A pinned sub-workflow as the engine walks it: all-safe migrations applied, then the Run
   * node's overrides (as validation checks it), with the sub-workflow's name for the trace.
   * null when the child is missing.
   */
  resolvePinnedChild(
    id: string,
    version: number,
    overrides: Record<string, JsonValue>,
  ): { name: string; graph: WorkflowGraph } | null {
    const ref = this.resolveSubworkflow(id, version);
    const workflow = ref && findWorkflow(this.deps.db, id);
    if (!ref || !workflow) return null;
    const { graph } = migratePinned(ref.graph, this.deps.registry);
    return { name: workflow.name, graph: applyOverrides(graph, overrides, this.deps.registry) };
  }

  /** A live sub-workflow's stored version; null when unknown, deleted, of kind workflow, missing or corrupt. */
  private resolveSubworkflow(id: string, version: number): SubworkflowRef | null {
    const workflow = findWorkflow(this.deps.db, id);
    if (workflow?.kind !== 'subworkflow') return null;
    const stored = findVersion(this.deps.db, id, version, this.upgradeJson);
    if (!stored?.ok) return null;
    return { graph: stored.row.graph, currentVersion: workflow.currentVersion };
  }

  private liveLibrary(id: string): boolean {
    const row = findLibrary(this.deps.db, id);
    return row !== null && row.deletedAt === null;
  }

  private outputRoots(): string[] {
    return this.deps.config?.outputRoots ?? [];
  }

  private validationContext(selfId?: string, cache?: ValidationCache): ValidationContext {
    return {
      registry: this.deps.registry,
      capabilities: this.deps.capabilities(),
      outputRoots: this.outputRoots(),
      resolveSubworkflow: (id, version) => this.resolveSubworkflow(id, version),
      libraryExists: (id) => this.liveLibrary(id),
      ...(selfId === undefined ? {} : { self: { id: selfId } }),
      ...(cache ? { cache } : {}),
    };
  }

  private issuesFor(graph: WorkflowGraph, selfId?: string, cache?: ValidationCache): Issue[] {
    return validateWorkflow(graph, this.validationContext(selfId, cache));
  }

  /**
   * The change text for a changed pin of a Run node present in both the base and the new
   * graph, or null when the pin is unchanged or the change is provably safe.
   */
  private pinChange(
    before: RunSubworkflowSettings | null,
    after: RunSubworkflowSettings | null,
  ): string | null {
    if (!before && !after) return null;
    const name = (id: string) =>
      findWorkflow(this.deps.db, id, { includeDeleted: true })?.name ?? id;
    if (!before || !after || before.subworkflowId !== after.subworkflowId) {
      const from = before ? `${name(before.subworkflowId)} ${before.version}` : 'none';
      const to = after ? `${name(after.subworkflowId)} ${after.version}` : 'none';
      return `Switched sub-workflow ${from}→${to}`;
    }
    if (before.version === after.version) return null;
    const oldChild = this.resolveSubworkflow(before.subworkflowId, before.version);
    const newChild = this.resolveSubworkflow(after.subworkflowId, after.version);
    const risk =
      oldChild && newChild
        ? comparePinChange(oldChild.graph, newChild.graph, after.overrides, this.deps.registry)
        : 'behaviour';
    return risk === 'safe'
      ? null
      : `Updated sub-workflow ${name(after.subworkflowId)} ${before.version}→${after.version}`;
  }

  private index(): CurrentIndex {
    const byId = new Map<string, CurrentEntry>();
    const usedBy = new Map<string, WorkflowRef[]>();
    for (const entry of listCurrentVersions(this.deps.db, this.upgradeJson)) {
      byId.set(entry.workflow.id, entry);
    }
    for (const { workflow, version, active } of byId.values()) {
      // A parent counts as a user through its current and its active version.
      const children = new Set<string>();
      for (const v of [version, active]) {
        if (!v?.ok) continue;
        for (const n of v.row.graph.nodes) {
          const s = runSettings(n);
          if (s && s.subworkflowId !== workflow.id) children.add(s.subworkflowId);
        }
      }
      for (const child of children) {
        if (byId.get(child)?.workflow.kind !== 'subworkflow') continue;
        const refs = usedBy.get(child) ?? [];
        refs.push({ id: workflow.id, name: workflow.name });
        usedBy.set(child, refs);
      }
    }
    for (const refs of usedBy.values()) refs.sort(byName);
    const libraries = new Map(listLibraries(this.deps.db).map((l) => [l.id, l.name]));
    return { byId, usedBy, libraries };
  }

  /**
   * The active state of a workflow: its pointer with whether the version can run (the check a real
   * run makes), and the issues that stop it. Always `{ active: null, issues: [] }` when not active.
   */
  private activeState(
    workflow: WorkflowRow,
    cache?: ValidationCache,
  ): { active: WorkflowActive; issues: Issue[] } {
    if (workflow.activeVersion === null) return { active: null, issues: [] };
    const loaded = this.loadForRun(workflow.id, workflow.activeVersion, cache);
    return {
      active: {
        version: workflow.activeVersion,
        runnable: loaded.kind === 'ok',
        // The columns are set together; updated_at is only a fallback for a hand-edited row.
        activatedAt: workflow.activatedAt ?? workflow.updatedAt,
        activatedBy: workflow.activatedBy ?? 'system:migration',
      },
      issues: loaded.kind === 'invalid' ? loaded.issues : [],
    };
  }

  /** `graph` null: the stored version is corrupt (one CORRUPT_GRAPH error). */
  private summary(
    workflow: WorkflowRow,
    graph: WorkflowGraph | null,
    issues: Issue[],
    index: CurrentIndex,
    active: WorkflowActive,
  ): WorkflowSummary {
    const errorCount = graph ? issues.filter((i) => i.severity === 'error').length : 1;
    const usesOutdatedSubworkflow =
      graph?.nodes.some((n) => {
        const s = runSettings(n);
        const child = s ? index.byId.get(s.subworkflowId)?.workflow : undefined;
        return !!s && child?.kind === 'subworkflow' && s.version < child.currentVersion;
      }) ?? false;
    const isWorkflow = workflow.kind === 'workflow';
    const fedId = isWorkflow && workflow.activeVersion !== null ? workflow.activeLibraryId : null;
    const fedName = fedId === null ? undefined : index.libraries.get(fedId);
    // Always the newest version's Library input, also when an older version is shown.
    const newest = index.byId.get(workflow.id)?.version;
    const newestGraph = newest ? (newest.ok ? newest.row.graph : null) : graph;
    const input = isWorkflow && newestGraph ? libraryInputOf(newestGraph) : null;
    return {
      id: workflow.id,
      name: workflow.name,
      kind: workflow.kind,
      active,
      currentVersion: workflow.currentVersion,
      valid: errorCount === 0,
      errorCount,
      usesOutdatedSubworkflow,
      usedBy: workflow.kind === 'subworkflow' ? (index.usedBy.get(workflow.id) ?? []) : [],
      feedsLibrary: fedId !== null && fedName !== undefined ? { id: fedId, name: fedName } : null,
      libraryInput: input?.libraryId
        ? { id: input.libraryId, name: index.libraries.get(input.libraryId) ?? null }
        : null,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }

  /** The summary of a live workflow's current version (corrupt → invalid). */
  private currentSummary(
    entry: CurrentEntry,
    index: CurrentIndex,
    cache?: ValidationCache,
  ): WorkflowSummary {
    const { active } = this.activeState(entry.workflow, cache);
    if (!entry.version.ok) return this.summary(entry.workflow, null, [], index, active);
    const graph = entry.version.row.graph;
    const issues = this.issuesFor(graph, entry.workflow.id, cache);
    return this.summary(entry.workflow, graph, issues, index, active);
  }

  private summaryOf(id: string): WorkflowSummary | null {
    const index = this.index();
    const entry = index.byId.get(id);
    return entry ? this.currentSummary(entry, index) : null;
  }
}
