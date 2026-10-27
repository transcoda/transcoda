import { resolve as resolvePath } from 'node:path';
import type { Capabilities } from '@transcoda/contract';
import {
  type AnyNodeDefinition,
  isPortRequired,
  type NodeMigration,
  parseSettings,
  type SettingsParseResult,
} from '@transcoda/sdk';
import {
  branchPortLabel,
  branchWord,
  type DeviceProfileId,
  type Edge,
  finishPhaseRank,
  type Issue,
  type JsonValue,
  LIBRARY_INPUT_TYPE,
  type NodeInstance,
  RUN_SUBWORKFLOW_TYPE,
  type RunSubworkflowSettings,
  RunSubworkflowSettingsSchema,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  syncLinkedSettings,
  valueNamed,
  type WorkflowGraph,
} from '@transcoda/shared';
import { resolveEncoder } from '../engine/build-model.ts';
import {
  checkEncodeAudioSettings,
  checkEncodeVideoSettings,
  checkRemuxSettings,
  type TargetIssue,
} from '../engine/targets.ts';
import {
  MOVE_COPY_TYPE,
  nodeAvailability,
  SIZE_GATE_ELSE_PORT,
  SIZE_GATE_TYPE,
} from '../nodes/availability.ts';
import type { NodeRegistry, RegisteredNode } from '../nodes/registry.ts';
import { isRemoteDefinition } from '../nodes/remote.ts';
import { applyOverrides, checkOverrides } from './subworkflow-settings.ts';
import { applySteps, migrationPath, rekeyEdges, stableStringify } from './upgrade.ts';

export interface SubworkflowRef {
  graph: WorkflowGraph;
  currentVersion: number;
}

export interface ValidationContext {
  registry: NodeRegistry;
  capabilities: Capabilities;
  /** Configured output roots (`TRANSCODA_OUTPUT_ROOTS`); `core:move-copy` must use one of them. */
  outputRoots: string[];
  /** null when the id is unknown, soft-deleted, not kind 'subworkflow', or the version does not exist / is corrupt. */
  resolveSubworkflow(id: string, version: number): SubworkflowRef | null;
  /** The saved workflow being validated (self-reference cycles). */
  self?: { id: string };
  /** Memo for pinned sub-workflows; pass one to share it across several validations. */
  cache?: ValidationCache;
  /**
   * Whether a live library has this id. When given, a Library input naming any other non-empty
   * id gets a LIBRARY_MISSING warning (it blocks activation, not saving or dry runs).
   */
  libraryExists?: (id: string) => boolean;
}

type NodeState =
  | { status: 'unknown' }
  | { status: 'newer' | 'outdated'; def: AnyNodeDefinition }
  | {
      status: 'current';
      def: AnyNodeDefinition;
      /** The parsed settings (defaults applied); null when they are invalid. */
      settings: Record<string, JsonValue> | null;
    };

function title(n: NodeInstance, def: AnyNodeDefinition | undefined): string {
  return n.label ?? def?.title ?? n.type;
}

function error(
  code: Issue['code'],
  message: string,
  at: Omit<Issue, 'severity' | 'code' | 'message'>,
): Issue {
  return { severity: 'error', code, message, ...at };
}

function warning(
  code: Issue['code'],
  message: string,
  at: Omit<Issue, 'severity' | 'code' | 'message'>,
): Issue {
  return { severity: 'warning', code, message, ...at };
}

export const behaviourHoldText = (nodeTitle: string): string =>
  `plugin update changes behaviour of ${nodeTitle}; review and activate a new version`;

/** The message for a node whose stored version is not this server's, or null when current. */
function versionProblem(
  n: NodeInstance,
  def: AnyNodeDefinition,
  plugin: string | null,
): string | null {
  if (n.typeVersion > def.version) {
    return `${title(n, def)} is at version ${n.typeVersion}, newer than this server's version ${def.version}`;
  }
  if (n.typeVersion < def.version) {
    if (isRemoteDefinition(def)) {
      // With a path the plugin host migrates the settings when the node runs: not a problem.
      const steps = migrationPath(def, n.typeVersion);
      if (steps !== null) {
        // A behaviour step is never run unreviewed: held like a core node, a person activates a
        // new version (the one the update wrote). Only safe-only paths migrate in the host.
        return steps.some((st) => st.risk !== 'safe') ? behaviourHoldText(title(n, def)) : null;
      }
      return `${title(n, def)} is at version ${n.typeVersion}; plugin ${plugin ?? def.type.split(':')[0]} no longer serves it (no upgrade path)`;
    }
    const noPath = migrationPath(def, n.typeVersion) === null ? ', and no upgrade path exists' : '';
    return `${title(n, def)} is at version ${n.typeVersion}; this server has version ${def.version}${noPath}`;
  }
  return null;
}

function safeParseSettings(def: AnyNodeDefinition, settings: JsonValue): SettingsParseResult {
  try {
    return parseSettings(def, settings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      issues: [{ path: '', message: `Settings could not be checked: ${message}`, missing: false }],
    };
  }
}

/** Checks 1 and 2: node type/version and settings. */
function checkNodes(
  graph: WorkflowGraph,
  ctx: ValidationContext,
  issues: Issue[],
): Map<string, NodeState> {
  const states = new Map<string, NodeState>();
  for (const n of graph.nodes) {
    const def = ctx.registry.get(n.type)?.def;
    if (!def) {
      states.set(n.id, { status: 'unknown' });
      issues.push(error('UNKNOWN_NODE_TYPE', `Unknown node type ${n.type}`, { nodeId: n.id }));
      continue;
    }
    const entry = ctx.registry.get(n.type);
    const problem = versionProblem(
      n,
      def,
      entry?.source.kind === 'plugin' ? entry.source.name : null,
    );
    if (problem) {
      const newer = n.typeVersion > def.version;
      states.set(n.id, { status: newer ? 'newer' : 'outdated', def });
      issues.push(
        error(newer ? 'UNKNOWN_NODE_VERSION' : 'NODE_OUTDATED', problem, { nodeId: n.id }),
      );
      continue;
    }
    if (isRemoteDefinition(def) && n.typeVersion < def.version) {
      // (reached only for a safe-only path: `versionProblem` reports the rest.) Pinned to an older plugin node version with a path: core does not parse these settings
      // (the schema is the new version's); the host validates them after migrating.
      const raw = n.settings;
      states.set(n.id, {
        status: 'current',
        def,
        settings: typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null,
      });
      continue;
    }
    const parsed = safeParseSettings(def, n.settings);
    states.set(n.id, { status: 'current', def, settings: parsed.ok ? parsed.value : null });
    if (!parsed.ok) {
      for (const issue of parsed.issues) {
        issues.push(
          error('INVALID_SETTINGS', issue.missing ? 'Needs a setting' : issue.message, {
            nodeId: n.id,
            ...(issue.path === '' ? {} : { settingPath: issue.path }),
          }),
        );
      }
    }
  }
  return states;
}

function defOf(state: NodeState | undefined): AnyNodeDefinition | undefined {
  return state && state.status !== 'unknown' ? state.def : undefined;
}

/** Check 3: edges and inputs. Returns the edges whose endpoints both exist. */
function checkEdges(graph: WorkflowGraph, states: Map<string, NodeState>, issues: Issue[]): Edge[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const existing: Edge[] = [];
  /** `${nodeId}\0${inputId}` → number of edges */
  const inputEdges = new Map<string, number>();
  for (const e of graph.edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (!from || !to) {
      const missing = from ? e.to.node : e.from.node;
      issues.push(
        error('DANGLING_EDGE', `Edge ${e.id} points at missing node ${missing}`, { edgeId: e.id }),
      );
      continue;
    }
    existing.push(e);
    const fromDef = defOf(states.get(from.id));
    const toDef = defOf(states.get(to.id));
    const input = toDef?.inputs.find((p) => p.id === e.to.port);
    if (input) {
      const key = `${to.id}\0${input.id}`;
      inputEdges.set(key, (inputEdges.get(key) ?? 0) + 1);
    }
    // An edge touching an unknown-type node gets only the existence check.
    if (!fromDef || !toDef) continue;
    const out = fromDef.outputs.find((p) => p.id === e.from.port);
    if (!out || !input) {
      const problems = [
        ...(out ? [] : [`${title(from, fromDef)} has no output ${e.from.port}`]),
        ...(input ? [] : [`${title(to, toDef)} has no input ${e.to.port}`]),
      ];
      issues.push(error('UNKNOWN_PORT', problems.join('; '), { edgeId: e.id }));
      continue;
    }
    if (out.type !== input.type) {
      issues.push(
        error(
          'PORT_TYPE_MISMATCH',
          `${title(from, fromDef)} output ${out.label} (${out.type}) cannot connect to ${title(to, toDef)} input ${input.label} (${input.type})`,
          { edgeId: e.id },
        ),
      );
    }
  }
  for (const n of graph.nodes) {
    const def = defOf(states.get(n.id));
    if (!def) continue;
    for (const input of def.inputs) {
      const count = inputEdges.get(`${n.id}\0${input.id}`) ?? 0;
      if (count > 1) {
        issues.push(
          error(
            'INPUT_MULTIPLE_EDGES',
            `${title(n, def)}: input ${input.label} has ${count} connections`,
            {
              nodeId: n.id,
            },
          ),
        );
      } else if (count === 0 && isPortRequired(input)) {
        issues.push(
          error('INPUT_UNCONNECTED', `${title(n, def)}: input ${input.label} is not connected`, {
            nodeId: n.id,
          }),
        );
      }
    }
  }
  checkSharedOutputs(byId, states, existing, issues);
  return existing;
}

/** SIZE_GATE_SHARED_OUTPUT: the gate decides for the steps after it, not for its siblings. */
export const SIZE_GATE_SHARED_TEXT =
  'The size gate must be the only step on this output; put the other steps after the gate\u2019s Yes or No.';

/**
 * A file follows one path, so a file output may feed several nodes only when every one is a
 * finish node (they all act on the one result and run in phase order; the engine's walk does the
 * same). One issue per offending edge, so the editor draws it broken:
 * - OUTPUT_MULTIPLE_EDGES (on the node the output leaves): an edge to a node that is not a
 *   finish node;
 * - SIZE_GATE_SHARED_OUTPUT (on the gate): a size gate among them; it would decide only for the
 *   steps wired after it, and the others would run whatever it decides;
 * - OUTPUT_MULTIPLE_WRITES (on each writing step): two or more steps that write the result.
 * Data outputs may feed any number of nodes. Targets of unknown type are left to their own
 * issue; bypassed finish targets run no hook, so they neither gate nor write.
 */
function checkSharedOutputs(
  byId: Map<string, NodeInstance>,
  states: Map<string, NodeState>,
  edges: Edge[],
  issues: Issue[],
): void {
  const byOutput = new Map<string, Edge[]>();
  for (const e of edges) {
    const key = `${e.from.node}\0${e.from.port}`;
    const list = byOutput.get(key);
    if (list) list.push(e);
    else byOutput.set(key, [e]);
  }
  for (const shared of byOutput.values()) {
    if (shared.length < 2) continue;
    const fromId = (shared[0] as Edge).from.node;
    const from = byId.get(fromId);
    const def = defOf(states.get(fromId));
    const out = def?.outputs.find((p) => p.id === (shared[0] as Edge).from.port);
    if (!from || !def || out?.type !== 'file') continue;
    const where = `${title(from, def)}\u2019s output ${out.label}`;
    const targets = shared.flatMap((e) => {
      const to = byId.get(e.to.node);
      const toDef = defOf(states.get(e.to.node));
      return to && toDef ? [{ e, to, toDef, runs: to.bypassed !== true }] : [];
    });
    const writes = targets.filter(
      (t) =>
        t.runs &&
        t.toDef.kind === 'finish' &&
        (WRITE_TYPES.has(t.toDef.type) || t.toDef.finishPhase === 'write'),
    );
    for (const { e, to, toDef, runs } of targets) {
      if (toDef.kind !== 'finish') {
        issues.push(
          error(
            'OUTPUT_MULTIPLE_EDGES',
            `${title(from, def)}: output ${out.label} has ${shared.length} connections, one to ${title(to, toDef)}; only finish steps can share an output (a file follows one path)`,
            { nodeId: fromId, edgeId: e.id },
          ),
        );
      } else if (runs && (toDef.type === SIZE_GATE_TYPE || toDef.finishPhase === 'gate')) {
        issues.push(
          error('SIZE_GATE_SHARED_OUTPUT', SIZE_GATE_SHARED_TEXT, { nodeId: to.id, edgeId: e.id }),
        );
      } else if (writes.length > 1 && writes.some((w) => w.e === e)) {
        issues.push(
          error(
            'OUTPUT_MULTIPLE_WRITES',
            `${title(to, toDef)}: ${where} has ${writes.length} steps that write the result; only one of them can be on an output`,
            { nodeId: to.id, edgeId: e.id },
          ),
        );
      }
    }
  }
}

/** Successor lists over existing edges; every node has an entry. */
type Adjacency = Map<string, string[]>;

function adjacency(graph: WorkflowGraph, edges: Edge[]): Adjacency {
  const next: Adjacency = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of edges) next.get(e.from.node)?.push(e.to.node);
  return next;
}

/**
 * Check 4: the first cycle found by DFS, as node ids with the first repeated at the end.
 * Iterative (explicit stack), so graph depth never reaches the call-stack limit.
 */
function findCycle(graph: WorkflowGraph, next: Adjacency): string[] | null {
  const done = new Set<string>();
  const onStack = new Set<string>();
  for (const start of graph.nodes) {
    if (done.has(start.id)) continue;
    const path: string[] = [start.id];
    const cursor: number[] = [0];
    onStack.add(start.id);
    while (path.length > 0) {
      const top = path.length - 1;
      const id = path[top] as string;
      const successors = next.get(id) ?? [];
      const i = cursor[top] as number;
      if (i === successors.length) {
        path.pop();
        cursor.pop();
        onStack.delete(id);
        done.add(id);
        continue;
      }
      cursor[top] = i + 1;
      const to = successors[i] as string;
      if (onStack.has(to)) return [...path.slice(path.indexOf(to)), to];
      if (done.has(to)) continue;
      path.push(to);
      cursor.push(0);
      onStack.add(to);
    }
  }
  return null;
}

/** Every node reachable from `roots` along `next` (roots included). */
function closure(roots: Iterable<string>, next: Adjacency): Set<string> {
  const reached = new Set(roots);
  const work = [...reached];
  for (let id = work.pop(); id !== undefined; id = work.pop()) {
    for (const to of next.get(id) ?? []) {
      if (reached.has(to)) continue;
      reached.add(to);
      work.push(to);
    }
  }
  return reached;
}

/** Check 5: kind rules and reachability. */
function checkKindRules(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  edges: Edge[],
  next: Adjacency,
  issues: Issue[],
): void {
  const kindOf = (n: NodeInstance) => defOf(states.get(n.id))?.kind;
  const notAllowed = (n: NodeInstance, where: string) =>
    issues.push(
      error(
        'NODE_NOT_ALLOWED_HERE',
        `${title(n, defOf(states.get(n.id)))} is not allowed in ${where}`,
        {
          nodeId: n.id,
        },
      ),
    );
  let roots: NodeInstance[];
  if (graph.kind === 'workflow') {
    roots = graph.nodes.filter((n) => kindOf(n) === 'trigger');
    if (roots.length !== 1) {
      issues.push(
        error('TRIGGER_COUNT', `A workflow needs exactly one trigger; it has ${roots.length}`, {}),
      );
    }
    for (const n of graph.nodes) {
      if (n.type === SUBWORKFLOW_START_TYPE || n.type === SUBWORKFLOW_END_TYPE)
        notAllowed(n, 'a workflow');
    }
    const finishes = graph.nodes.filter((n) => kindOf(n) === 'finish');
    const root = roots.length === 1 ? roots[0] : undefined;
    const reached = root ? closure([root.id], next) : new Set<string>();
    if (finishes.length === 0 || (root && !finishes.some((n) => reached.has(n.id)))) {
      issues.push(error('NO_FINISH_PATH', 'No finish node can be reached from the trigger', {}));
    }
  } else {
    for (const n of graph.nodes) {
      const kind = kindOf(n);
      if (kind === 'trigger' || kind === 'finish') notAllowed(n, 'a sub-workflow');
    }
    roots = graph.nodes.filter((n) => n.type === SUBWORKFLOW_START_TYPE);
    const ends = graph.nodes.filter((n) => n.type === SUBWORKFLOW_END_TYPE).length;
    if (roots.length !== 1 || ends === 0) {
      issues.push(
        error(
          'SUBWORKFLOW_IO_COUNT',
          `A sub-workflow needs exactly one start and at least one end; it has ${roots.length} start and ${ends} end nodes`,
          {},
        ),
      );
    }
  }

  const root = roots.length === 1 ? roots[0] : undefined;
  if (!root) return;
  // Data nodes feeding a reachable node (via a data:* output) count as reachable, transitively:
  // walk data edges backwards from everything forward-reachable.
  const feeders: Adjacency = new Map();
  for (const e of edges) {
    const out = defOf(states.get(e.from.node))?.outputs.find((p) => p.id === e.from.port);
    if (!out?.type.startsWith('data:')) continue;
    const list = feeders.get(e.to.node);
    if (list) list.push(e.from.node);
    else feeders.set(e.to.node, [e.from.node]);
  }
  const reachable = closure(closure([root.id], next), feeders);
  for (const n of graph.nodes) {
    if (reachable.has(n.id)) continue;
    issues.push(
      warning(
        'NODE_UNREACHABLE',
        `${title(n, defOf(states.get(n.id)))} is not reachable from ${title(root, defOf(states.get(root.id)))}`,
        {
          nodeId: n.id,
        },
      ),
    );
  }
}

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

/** One problem inside a pinned sub-workflow; `chain` names the sub-workflows below it (`<id> version <v>`). */
interface ChildProblem {
  chain: string[];
  message: string;
}

/**
 * Per-call (or, shared by the caller, per-listing) memo for validating pinned sub-workflows.
 * Results computed while a reference cycle was cut short may miss problems behind the cycle;
 * every Run node reaching such a cycle gets SUBWORKFLOW_REFERENCE_CYCLE anyway.
 */
export interface ValidationCache {
  /** `${id}@${version}#${overrides}` → the errors found in that child with those overrides. */
  results: Map<string, ChildProblem[]>;
  /** `${id}@${version}` of the children being validated (the recursion stack). */
  active: Set<string>;
  /** SUBWORKFLOW_BROKEN issues made inside a child → the problem they carry, for the chain. */
  nested: WeakMap<Issue, { ref: string; problem: ChildProblem }>;
  /** `${id}@${version}` → what `ctx.resolveSubworkflow` returned (looked up once per cache). */
  resolved: Map<string, SubworkflowRef | null>;
  /** `${id}@${version}` → the sub-workflow ids it reaches, for refs explored without a cycle. */
  clean: Map<string, Set<string>>;
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
    const issues = validateWorkflow(graph, { ...ctx, self: { id: s.subworkflowId }, cache });
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
function checkSubworkflowRefs(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  ctx: ValidationContext,
  cache: ValidationCache,
  issues: Issue[],
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
    for (const problem of childProblems({ ...s, overrides: applied }, ref, ctx, cache)) {
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

/** Finish nodes that write the result (replace the original, or write it under an output root). */
const WRITE_TYPES: ReadonlySet<string> = new Set(['core:replace-original', MOVE_COPY_TYPE]);

const ELSE_ONLY_NOTIFY_TEXT =
  'After the size gate\u2019s \u201cNo\u201d, only notifications and other non-writing finish steps can follow.';

/** `${nodeId}:${port}` → the nodes that output feeds (existing edges only). */
type PortAdjacency = Map<string, string[]>;

function portAdjacency(edges: Edge[]): PortAdjacency {
  const next: PortAdjacency = new Map();
  for (const e of edges) {
    const key = `${e.from.node}:${e.from.port}`;
    const list = next.get(key);
    if (list) list.push(e.to.node);
    else next.set(key, [e.to.node]);
  }
  return next;
}

/** The single trigger of a workflow; undefined for a sub-workflow or a trigger count other than 1. */
function triggerOf(graph: WorkflowGraph, states: Map<string, NodeState>): NodeInstance | undefined {
  if (graph.kind !== 'workflow') return undefined;
  const triggers = graph.nodes.filter((n) => defOf(states.get(n.id))?.kind === 'trigger');
  return triggers.length === 1 ? triggers[0] : undefined;
}

/**
 * FINISH_ORDER and NO_WRITE_PATH: every path from the trigger, walked per file output port with
 * two flags ("a write node was passed", "a finish node was passed"). Iterative DFS memoised on
 * `(node, flags)`, so each node is expanded at most four times whatever the number of paths.
 * Bypassed nodes run no hook (the engine passes the file through on their first file output), so
 * they neither set the flags nor break the order. Returns the number of expansions.
 */
function checkPaths(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  edges: Edge[],
  issues: Issue[],
): number {
  const root = triggerOf(graph, states);
  if (!root) return 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = portAdjacency(edges);
  const fromPorts = new Map<string, string[]>();
  for (const e of edges) {
    const ports = fromPorts.get(e.from.node) ?? [];
    if (!ports.includes(e.from.port)) ports.push(e.from.port);
    fromPorts.set(e.from.node, ports);
  }
  const reported = new Set<string>();
  const report = (key: string, issue: Issue) => {
    if (reported.has(key)) return;
    reported.add(key);
    issues.push(issue);
  };
  const expanded = new Set<string>();
  // `rank`: the highest finish phase passed so far (-1: none); `by` names the node that set it.
  const stack: Array<{
    id: string;
    wrote: boolean;
    finished: boolean;
    rank: number;
    by: string;
    /** Below a size gate's `else`: nothing may write there, and nothing needs to. */
    afterElse: boolean;
  }> = [{ id: root.id, wrote: false, finished: false, rank: -1, by: '', afterElse: false }];
  let visits = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { id } = top;
    const key = `${id}:${top.wrote ? 1 : 0}${top.finished ? 1 : 0}${top.afterElse ? 1 : 0}:${top.rank}`;
    const n = byId.get(id);
    if (!n || expanded.has(key)) continue;
    expanded.add(key);
    visits++;
    const def = defOf(states.get(id));
    const name = title(n, def);
    let { wrote, finished, rank, by } = top;
    const { afterElse } = top;
    if (def && n.bypassed !== true) {
      if (
        afterElse &&
        def.kind === 'finish' &&
        (WRITE_TYPES.has(def.type) ||
          def.type === SIZE_GATE_TYPE ||
          def.finishPhase === 'write' ||
          def.finishPhase === 'gate')
      ) {
        report(
          `else-only-notify:${id}`,
          error('ELSE_ONLY_NOTIFY', ELSE_ONLY_NOTIFY_TEXT, { nodeId: id }),
        );
      }
      if (def.kind !== 'finish' && finished) {
        report(
          `order-finish:${id}`,
          error(
            'FINISH_ORDER',
            `${name} comes after a finish node; only finish nodes may follow one`,
            { nodeId: id },
          ),
        );
      }
      if (def.kind === 'finish') {
        finished = true;
        const phase = def.finishPhase;
        if (phase !== undefined) {
          const own = finishPhaseRank(phase);
          if (own < rank) {
            report(
              `order-phase:${id}`,
              error(
                'FINISH_ORDER',
                `${name} (${phase}) comes after ${by}; finish nodes run render → gate → write → library manager → media server → notify`,
                { nodeId: id },
              ),
            );
          } else {
            rank = own;
            by = `${name} (${phase})`;
          }
        }
      }
      if (WRITE_TYPES.has(def.type)) wrote = true;
    }
    const fileOutputs = def
      ? def.outputs.filter((p) => p.type === 'file').map((p) => p.id)
      : (fromPorts.get(id) ?? []);
    const ports = n.bypassed === true ? fileOutputs.slice(0, 1) : fileOutputs;
    const connected = ports.filter((p) => (next.get(`${id}:${p}`)?.length ?? 0) > 0);
    // The gate's unconnected `else` is fine: the original is kept and nothing is written there.
    const isGate = def?.type === SIZE_GATE_TYPE && n.bypassed !== true;
    const warnPorts = isGate ? ports.filter((p) => p !== SIZE_GATE_ELSE_PORT) : ports;
    if (!wrote && !afterElse) {
      if (connected.length === 0) {
        report(
          `write:${id}`,
          warning('NO_WRITE_PATH', 'this path never writes the result', { nodeId: id }),
        );
      }
      for (const port of connected.length === 0 ? [] : warnPorts) {
        if (connected.includes(port)) continue;
        // The words people read on the node (Yes/No), not the stored id.
        const shown = def?.outputs.find((p) => p.id === port);
        const word = shown ? branchPortLabel(shown) : (branchWord(port) ?? port);
        report(
          `write:${id}:${port}`,
          warning(
            'NO_WRITE_PATH',
            `this path never writes the result (output "${word}" is unconnected)`,
            { nodeId: id },
          ),
        );
      }
    }
    for (const port of [...connected].reverse()) {
      const targets = next.get(`${id}:${port}`) ?? [];
      const branchElse = afterElse || (isGate && port === SIZE_GATE_ELSE_PORT);
      // Finish nodes sharing an output run as one set (the write before the rest), so a write
      // anywhere in the set counts for every path through it.
      const setWrites = targets.length > 1 && sharedSetWrites(targets, byId, states, next);
      for (const to of [...targets].reverse()) {
        stack.push({
          id: to,
          wrote: wrote || setWrites,
          finished,
          rank,
          by,
          afterElse: branchElse,
        });
      }
    }
  }
  return visits;
}

/** Whether a running write node is among the finish nodes reachable from `starts` (all finish). */
function sharedSetWrites(
  starts: string[],
  byId: Map<string, NodeInstance>,
  states: Map<string, NodeState>,
  next: PortAdjacency,
): boolean {
  const seen = new Set<string>();
  const work = [...starts];
  for (let id = work.pop(); id !== undefined; id = work.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    const def = defOf(states.get(id));
    if (!n || def?.kind !== 'finish') return false;
    if (n.bypassed !== true && WRITE_TYPES.has(def.type)) return true;
    const port = def.outputs.find((p) => p.type === 'file')?.id;
    if (port !== undefined) work.push(...(next.get(`${id}:${port}`) ?? []));
  }
  return false;
}

/**
 * The path rules alone, with the number of `(node, flags)` expansions — for tests of the
 * memoisation; `validateWorkflow` reports the same issues.
 */
export function walkPathRules(
  graph: WorkflowGraph,
  ctx: ValidationContext,
): { issues: Issue[]; visits: number } {
  const scratch: Issue[] = [];
  const states = checkNodes(graph, ctx, scratch);
  const edges = checkEdges(graph, states, scratch);
  const issues: Issue[] = [];
  const visits = checkPaths(graph, states, edges, issues);
  return { issues, visits };
}

/** The static target check of a node's settings, or [] for nodes without `targets`. */
function targetIssues(type: string, s: Record<string, JsonValue>): TargetIssue[] {
  // The settings parsed against the node's schema, so these casts hold.
  const targets = s.targets as DeviceProfileId[];
  switch (type) {
    case 'core:encode-video':
      return checkEncodeVideoSettings({ codec: s.codec as string, targets });
    case 'core:encode-audio':
      return checkEncodeAudioSettings({ codec: s.codec as string, targets });
    case 'core:remux':
      return checkRemuxSettings({ container: s.container as 'mkv' | 'mp4', targets });
    default:
      return [];
  }
}

/** Setting-aware checks on nodes with valid current settings: output roots, targets, encoders. */
/** An absolute path resolved: no trailing slash, no `.`/`..` segments. */
const normalRoot = (p: string): string => resolvePath(p);

function checkSettingValues(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  ctx: ValidationContext,
  issues: Issue[],
): void {
  const caps = ctx.capabilities;
  for (const n of graph.nodes) {
    const state = states.get(n.id);
    if (state?.status !== 'current' || state.settings === null) continue;
    const { def, settings: s } = state;
    const name = title(n, def);
    // With no roots at all the node is NODE_UNAVAILABLE instead. Compared resolved (a trailing
    // slash or `..` does not matter), as the pipeline compares them.
    if (
      def.type === MOVE_COPY_TYPE &&
      ctx.outputRoots.length > 0 &&
      !ctx.outputRoots.map(normalRoot).includes(normalRoot(s.outputRoot as string))
    ) {
      issues.push(
        error('INVALID_SETTINGS', 'outputRoot must be one of the configured output roots', {
          nodeId: n.id,
          settingPath: 'outputRoot',
        }),
      );
    }
    // A bypassed node runs no hook: its targets and encoder never matter (it may be bypassed
    // precisely because its encoder is missing here).
    if (n.bypassed === true) continue;
    for (const t of targetIssues(def.type, s)) {
      issues.push(
        error('TARGET_UNSUPPORTED', `${name}: ${t.message}`, {
          nodeId: n.id,
          settingPath: 'targets',
        }),
      );
    }
    // Without ffmpeg every encoder is missing; NODE_UNAVAILABLE / the capabilities say so.
    if (def.type === 'core:encode-video' && caps.available) {
      const codec = s.codec as 'hevc' | 'h264' | 'av1';
      const encoder = s.encoder as string;
      if (resolveEncoder(codec, encoder, caps) === null) {
        const message =
          encoder === 'auto'
            ? `${name}: no ${codec} encoder is available`
            : `${name}: encoder ${encoder} is not available`;
        issues.push(
          error('ENCODER_UNAVAILABLE', message, { nodeId: n.id, settingPath: 'encoder' }),
        );
      }
    }
  }
}

/** A Library input naming a library that does not exist (or is deleted). An empty id is INVALID_SETTINGS. */
function checkLibraries(graph: WorkflowGraph, ctx: ValidationContext, issues: Issue[]): void {
  const exists = ctx.libraryExists;
  if (!exists) return;
  for (const n of graph.nodes) {
    if (n.type !== LIBRARY_INPUT_TYPE) continue;
    const settings = n.settings;
    const id =
      settings !== null && typeof settings === 'object' && !Array.isArray(settings)
        ? settings.libraryId
        : undefined;
    if (typeof id !== 'string' || id === '' || exists(id)) continue;
    issues.push(
      warning('LIBRARY_MISSING', 'Library input: no library with this id', {
        nodeId: n.id,
        settingPath: 'libraryId',
      }),
    );
  }
}

/** A node whose `groupId` names no group (harmless for the engine; the editor should not see it). */
function checkGroups(graph: WorkflowGraph, states: Map<string, NodeState>, issues: Issue[]): void {
  const groups = new Set(graph.groups.map((g) => g.id));
  for (const n of graph.nodes) {
    if (n.groupId === undefined || groups.has(n.groupId)) continue;
    issues.push(
      warning(
        'GROUP_MISSING',
        `${title(n, defOf(states.get(n.id)))} is in group ${n.groupId}, which does not exist`,
        { nodeId: n.id },
      ),
    );
  }
}

/** A setting that follows a shared value the graph does not have (the setting keeps its copy). */
function checkValueLinks(
  graph: WorkflowGraph,
  states: Map<string, NodeState>,
  issues: Issue[],
): void {
  for (const n of graph.nodes) {
    for (const [key, name] of Object.entries(n.links ?? {})) {
      if (valueNamed(graph, name)) continue;
      issues.push(
        warning(
          'VALUE_MISSING',
          `${title(n, defOf(states.get(n.id)))} follows the shared value "${name}", which does not exist`,
          { nodeId: n.id, settingPath: key },
        ),
      );
    }
  }
}

export function validateWorkflow(sent: WorkflowGraph, ctx: ValidationContext): Issue[] {
  // Linked settings are judged by the value they follow.
  const graph = syncLinkedSettings(sent);
  const cache = ctx.cache ?? createValidationCache();
  const issues: Issue[] = [];
  const states = checkNodes(graph, ctx, issues);
  const edges = checkEdges(graph, states, issues);
  const next = adjacency(graph, edges);
  const cycle = findCycle(graph, next);
  if (cycle) {
    issues.push(
      error('GRAPH_CYCLE', `The workflow has a cycle: ${cycle.join(' → ')}`, {
        nodeId: cycle[0] as string,
      }),
    );
  }
  checkKindRules(graph, states, edges, next, issues);
  checkPaths(graph, states, edges, issues);
  checkSettingValues(graph, states, ctx, issues);
  checkSubworkflowRefs(graph, states, ctx, cache, issues);
  for (const n of graph.nodes) {
    const def = defOf(states.get(n.id));
    if (!def) continue;
    // A node with a definition always has its registry entry (the definition came from it).
    const entry = ctx.registry.get(n.type) as RegisteredNode;
    const down = entry.unavailable?.() ?? null;
    if (down !== null) {
      // The settings were still validated above (the persisted schema stays known).
      issues.push(
        error('PLUGIN_UNAVAILABLE', `${title(n, def)} can't run: ${down}`, { nodeId: n.id }),
      );
      continue;
    }
    const availability = nodeAvailability(entry, ctx.capabilities, {
      outputRoots: ctx.outputRoots,
    });
    if (!availability.available) {
      issues.push(
        error('NODE_UNAVAILABLE', `${title(n, def)} is unavailable here: ${availability.reason}`, {
          nodeId: n.id,
        }),
      );
    }
  }
  checkLibraries(graph, ctx, issues);
  checkGroups(graph, states, issues);
  checkValueLinks(graph, states, issues);
  return issues;
}
