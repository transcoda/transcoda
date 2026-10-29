import {
  type AnyFinishAction,
  type AnyNodeDefinition,
  type BuildModel,
  corePluginContext,
  type DataValue,
  type FileStats,
  type HookContextBase,
  type ProbeResult,
  parseSettings,
} from '@transcoda/sdk';
import {
  type Edge,
  FINISH_PHASES,
  finishPhaseRank,
  type JsonValue,
  type NodeInstance,
  portShown,
  RUN_SUBWORKFLOW_TYPE,
  RunSubworkflowSettingsSchema,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  type TraceChanges,
  type TraceEntry,
  type WorkflowGraph,
} from '@transcoda/shared';
import {
  CHECK_SOURCE_DAMAGED_PORT,
  CHECK_SOURCE_TYPE,
  RENDER_DAMAGED_PORT,
  RENDER_TYPE,
  SIZE_GATE_ELSE_PORT,
  SIZE_GATE_TYPE,
} from '../nodes/availability.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import { isRemoteDefinition, RemoteHookError } from '../nodes/remote.ts';
import { migrationPath } from '../workflows/upgrade.ts';
import { behaviourHoldText, SIZE_GATE_SHARED_TEXT } from '../workflows/validate.ts';
import { isExtraStream, modelFromProbe } from './build-model.ts';
import type { CoreTools } from './check-source.ts';
import { modelChanges } from './model-changes.ts';
import type { AutoPick } from './retarget.ts';

/** The Encode video node, whose `auto` encoder picks the walk records (autoPicks). */
const ENCODE_VIDEO_TYPE = 'core:encode-video';

export interface WalkDeps {
  registry: NodeRegistry;
  /** A pinned sub-workflow (name and graph, migrated, overrides applied); null when missing. */
  resolveChild(
    id: string,
    version: number,
    overrides: Record<string, JsonValue>,
  ): { name: string; graph: WorkflowGraph } | null;
  now(): Date;
  onTrace(entry: TraceEntry): void;
  /** Called as the walk reaches each path node (decide) and each action/finish node (build). */
  onNodeStart?(node: { workflowPath: string[]; nodeId: string }): void;
  capabilities: HookContextBase['capabilities'];
  log(message: string): void;
  /** Engine tools for core nodes (Check source); absent: such a node fails the walk. */
  core?: CoreTools;
}

export interface WalkInput {
  graph: WorkflowGraph;
  probe: ProbeResult;
  file: FileStats;
  attempt: number;
  /** The `seq` of the first trace entry (default 1), so seq stays monotonic across attempts. */
  firstSeq?: number;
  /** Handed to hooks as `ctx.plugin.dryRun` (default false). */
  dryRun?: boolean;
  /** Handed to hooks as `ctx.plugin.job` (with `attempt`); absent: no job. */
  jobId?: string;
}

/** One node on the file's path and the file output it left by (null: it never left). */
export interface PathStep {
  /** Run-node ids from the top-level graph down to the node's graph; [] at top level. */
  workflowPath: string[];
  nodeId: string;
  port: string | null;
}

export interface NodeRef extends PathStep {
  graph: WorkflowGraph;
}

export type WalkFailure = {
  kind: 'failed';
  nodeId: string;
  workflowPath: string[];
  reason: string;
  /** The path up to and including the failing node. */
  path: PathStep[];
  /**
   * A hook failed in a way a second attempt may fix (the pipeline's retry-once rule): a plugin's
   * retryable error, or a core node's (Check source could not read the file).
   */
  retryable: boolean;
};

/** Where the path left a Check source by Damaged, and what it found. */
export interface SourceDamagedAt {
  nodeId: string;
  damage: { reason: string; stream?: string };
}

/** Data-node values by `dataKey` → `{ [outputPortId]: value }`. */
type DataMemo = Map<string, Record<string, DataValue>>;

export type DecidedPath = {
  kind: 'decided';
  /** Every node the file passes, in order (trigger, Run nodes, Start/End of sub-workflows included). */
  nodes: NodeRef[];
  /**
   * Per size gate (by node id, top level only), the finish nodes behind its `else`, in order.
   * They are not on `nodes`: the file leaves by `else` only when the gate fails.
   */
  elseNodes: Map<string, NodeRef[]>;
  /**
   * Per Render with Quality check on (by node id, top level only), the finish nodes behind its
   * Damaged, in order. They are not on `nodes`: the file leaves by Damaged only when the source
   * turns out damaged while rendering.
   */
  damagedNodes: Map<string, NodeRef[]>;
  /**
   * The path left a (top-level) Check source by Damaged: the finish nodes after it are on
   * `nodes` and run without anything rendered or written. Null otherwise.
   */
  sourceDamagedAt: SourceDamagedAt | null;
  /** Keyed by `${workflowPath.join('/')}/${nodeId}` of the data node. */
  data: DataMemo;
  /** The `seq` the build phase continues with. */
  nextSeq: number;
};

/** What a size gate does when it fails: the actions behind its `else` and where they sit. */
export interface GateBranch {
  nodeId: string;
  /** The gate's size-gate action in `actions`. */
  actionIndex: number;
  /** Notifications and other non-writing steps, in order; never replace or move-copy. */
  elseActions: AnyFinishAction[];
  elsePath: PathStep[];
}

/** What a Render does when the source turns out damaged: the steps behind its Damaged. */
export interface DamagedBranch {
  nodeId: string;
  /** The Render's render action in `actions`. */
  actionIndex: number;
  /** Notifications and other non-writing steps, in order; never render, gate or write. */
  actions: AnyFinishAction[];
  path: PathStep[];
}

export type WalkResult =
  | {
      kind: 'built';
      model: BuildModel;
      actions: AnyFinishAction[];
      gates: GateBranch[];
      /**
       * The Damaged side of the Render on the path; null when its Quality check is off, its
       * Damaged is unconnected, or the path has no running Render.
       */
      damaged: DamagedBranch | null;
      /**
       * The path left a Check source by Damaged: `actions` are the (non-writing) finish steps
       * after it; nothing is rendered. Null otherwise.
       */
      sourceDamagedAt: SourceDamagedAt | null;
      path: PathStep[];
      /** Video streams an `auto` Encode video put on an encoder; the main path only. */
      autoPicks: AutoPick[];
    }
  | WalkFailure;

/** Thrown inside the walk; turned into the WalkFailure result (with the path) at the phase boundary. */
class WalkFailed extends Error {
  constructor(
    readonly nodeId: string,
    readonly workflowPath: string[],
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(reason);
  }
}

function step({ workflowPath, nodeId, port }: PathStep): PathStep {
  return { workflowPath: [...workflowPath], nodeId, port };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dataKey(workflowPath: string[], nodeId: string): string {
  return `${workflowPath.join('/')}/${nodeId}`;
}

/**
 * What a plugin build hook must leave alone: the extra input files and which streams read them.
 * Extra-stream pairs are sorted so a re-sorted array is not a change; source streams are checked
 * apart (none may read an input), so dropping or re-ordering them is not one either.
 */
function inputFilesOf(model: BuildModel): string {
  return JSON.stringify([
    model.extraInputs ?? [],
    model.streams
      .filter(isExtraStream)
      .map((s) => [s.sourceIndex, s.input])
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
  ]);
}

/** A stream that is not from an extra input must not claim an `input` (a re-pointed stream). */
function repointsSourceStream(model: BuildModel): boolean {
  return model.streams.some((s) => !isExtraStream(s) && (s.input ?? 0) !== 0);
}

/** The node's file outputs its settings show; the walk never follows a hidden one. */
function fileOutputs(def: AnyNodeDefinition, n: NodeInstance): string[] {
  return def.outputs.filter((p) => p.type === 'file' && portShown(p, n.settings)).map((p) => p.id);
}

/** A Render that runs with Quality check on: its Damaged output is shown. */
function checksQuality(def: AnyNodeDefinition, n: NodeInstance): boolean {
  return n.type === RENDER_TYPE && fileOutputs(def, n).includes(RENDER_DAMAGED_PORT);
}

/** Which subtree a no-write build walks, in the words of its failure text. */
const NO_WRITE_WHERE = {
  else: 'the size gate\u2019s No branch',
  damaged: 'Render\u2019s Damaged',
  source: 'Check source\u2019s Damaged',
} as const;
type NoWrite = keyof typeof NO_WRITE_WHERE;

/** A Check source in a sub-workflow (validation refuses one): its Damaged would lead back out. */
const CHECK_SOURCE_NESTED_TEXT = 'Check source is not allowed in a sub-workflow';

/** Kinds with no hook: the walk traces them as `pass` and ignores their bypass flag. */
const PASS_KINDS: ReadonlySet<string> = new Set(['trigger', 'subworkflow-io']);

type Phase = TraceEntry['phase'];
type Outcome = {
  port: string | null;
  reason: string;
  findings: Record<string, JsonValue>;
  changes?: TraceChanges;
};
type Source = NonNullable<TraceEntry['source']>;

function sourceField(source: Source | undefined): { source?: Source } {
  return source === undefined ? {} : { source };
}

function title(n: NodeInstance, def: AnyNodeDefinition): string {
  return n.label ?? def.title;
}

class Walker {
  /** The path so far, for a failure. */
  steps: NodeRef[] = [];
  /** The finish nodes behind each size gate's `else`, by gate node id. */
  readonly elseSteps = new Map<string, NodeRef[]>();
  /** The finish nodes behind each top-level Render's Damaged (Quality check on), by node id. */
  readonly damagedSteps = new Map<string, NodeRef[]>();
  /** Where each size gate's action starts in the actions the build collects. */
  readonly gateIndex = new Map<string, number>();
  /** Where each Render's action starts in the actions the build collects. */
  readonly renderIndex = new Map<string, number>();
  /** Set once the path leaves a Check source by Damaged. */
  sourceDamagedAt: SourceDamagedAt | null = null;
  /** Where each node seen so far comes from, for the trace's `source`. */
  private readonly sources = new Map<string, Source>();
  /**
   * The finish actions of each finish node built so far (dataKey). A node several branches lead
   * into (a notify behind both Yes and No) is built once: the other branches reuse its actions,
   * so its hook runs, and is traced, once.
   */
  private readonly finished = new Map<string, AnyFinishAction[]>();

  constructor(
    private readonly deps: WalkDeps,
    private readonly input: WalkInput,
    private readonly memo: DataMemo,
    public seq: number,
  ) {}

  /** Traces `failed: <reason>` on the node and fails the walk. */
  fail(nodeId: string, path: string[], phase: Phase, reason: string): never {
    const startedAt = this.deps.now();
    this.trace(nodeId, path, phase, startedAt, {
      port: null,
      reason: `failed: ${reason}`,
      findings: {},
    });
    throw new WalkFailed(nodeId, [...path], reason);
  }

  /** Why the node's plugin cannot run now, or null. */
  down(n: NodeInstance): string | null {
    return this.deps.registry.get(n.type)?.unavailable?.() ?? null;
  }

  /** The trace reason of a bypassed node; an unavailable plugin node is still skipped, noted. */
  bypassReason(n: NodeInstance): string {
    const down = this.down(n);
    return down === null ? 'bypassed' : `bypassed (${down})`;
  }

  /**
   * The node's definition. A node whose plugin cannot run fails the walk (never runs as
   * unknown), unless it is bypassed: bypass keeps its semantics and the node is skipped.
   */
  def(n: NodeInstance, path: string[], phase: Phase = 'pass'): AnyNodeDefinition {
    const entry = this.deps.registry.get(n.type);
    if (!entry) return this.fail(n.id, path, 'pass', `unknown node type ${n.type}`);
    this.sources.set(dataKey(path, n.id), entry.source.kind);
    const down = entry.unavailable?.() ?? null;
    if (down !== null && n.bypassed !== true) {
      return this.fail(n.id, path, phase, `${title(n, entry.def)} can't run: ${down}`);
    }
    return entry.def;
  }

  trace(nodeId: string, path: string[], phase: Phase, startedAt: Date, outcome: Outcome): void {
    this.deps.onTrace({
      seq: this.seq++,
      attempt: this.input.attempt,
      nodeId,
      workflowPath: [...path],
      phase,
      ...sourceField(this.sources.get(dataKey(path, nodeId))),
      port: outcome.port,
      reason: outcome.reason,
      findings: outcome.findings,
      ...(outcome.changes ? { changes: outcome.changes } : {}),
      startedAt: startedAt.toISOString(),
      endedAt: this.deps.now().toISOString(),
    });
  }

  /** A trace entry for a node that runs no hook. */
  note(nodeId: string, path: string[], phase: Phase, port: string | null, reason: string): void {
    this.trace(nodeId, path, phase, this.deps.now(), { port, reason, findings: {} });
  }

  base(
    n: NodeInstance,
    data: Record<string, DataValue>,
  ): HookContextBase & { nodeVersion: number } {
    return {
      // Server-side only: a plugin node pinned to an older version is migrated by its host.
      nodeVersion: n.typeVersion,
      // Server-side only too (wireContext strips it): the engine's tools for core nodes.
      ...(this.deps.core && this.deps.registry.get(n.type)?.source.kind === 'core'
        ? { core: this.deps.core }
        : {}),
      probe: this.input.probe,
      file: this.input.file,
      data,
      capabilities: this.deps.capabilities,
      log: (m) => this.deps.log(`${n.id}: ${m}`),
      plugin: corePluginContext({
        dryRun: this.input.dryRun ?? false,
        job: this.input.jobId ? { id: this.input.jobId, attempt: this.input.attempt } : null,
      }),
    };
  }

  settings(def: AnyNodeDefinition, n: NodeInstance): Record<string, JsonValue> {
    // A plugin node pinned to an older version: its settings are not this version's schema, so
    // they go to the host as stored, which migrates and validates them before the hook runs.
    if (isRemoteDefinition(def) && n.typeVersion < def.version) {
      const raw = n.settings;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('invalid settings: not an object');
      }
      // Defence in depth (validation holds these first): a behaviour step is never run unreviewed.
      if (migrationPath(def, n.typeVersion)?.some((st) => st.risk !== 'safe')) {
        throw new Error(behaviourHoldText(n.label ?? def.title));
      }
      return raw;
    }
    const parsed = parseSettings(def, n.settings);
    if (parsed.ok) return parsed.value;
    const first = parsed.issues[0];
    throw new Error(`invalid settings: ${first ? `${first.path}: ${first.message}` : 'unknown'}`);
  }

  /** Runs one hook and traces it; a throw is traced and fails the walk. */
  async hook<T>(
    n: NodeInstance,
    path: string[],
    phase: Phase,
    call: () => Promise<T>,
    outcome: (result: T) => Outcome,
  ): Promise<T> {
    const startedAt = this.deps.now();
    let result: T;
    try {
      result = await call();
    } catch (err) {
      const reason = message(err);
      this.trace(n.id, path, phase, startedAt, {
        port: null,
        reason: `failed: ${reason}`,
        findings: {},
      });
      throw new WalkFailed(
        n.id,
        [...path],
        reason,
        err instanceof RemoteHookError
          ? err.retryable
          : (err as { retryable?: unknown } | null)?.retryable === true,
      );
    }
    this.trace(n.id, path, phase, startedAt, outcome(result));
    return result;
  }

  /** The node's data inputs by input port id; unconnected or unavailable ones are 'unknown'. */
  async dataFor(
    n: NodeInstance,
    def: AnyNodeDefinition,
    graph: WorkflowGraph,
    path: string[],
    active = new Set<string>(),
  ): Promise<Record<string, DataValue>> {
    const data: Record<string, DataValue> = {};
    for (const port of def.inputs) if (port.type.startsWith('data:')) data[port.id] = 'unknown';
    for (const e of graph.edges) {
      if (e.to.node !== n.id || !(e.to.port in data)) continue;
      const source = graph.nodes.find((x) => x.id === e.from.node);
      if (!source) continue;
      const values = await this.evaluateData(source, graph, path, active);
      data[e.to.port] = values[e.from.port] ?? 'unknown';
    }
    return data;
  }

  /** A data node's outputs, evaluated once per walk (memo); never fails the walk. */
  async evaluateData(
    n: NodeInstance,
    graph: WorkflowGraph,
    path: string[],
    active: Set<string>,
  ): Promise<Record<string, DataValue>> {
    const key = dataKey(path, n.id);
    const hit = this.memo.get(key);
    if (hit) return hit;
    const entry = this.deps.registry.get(n.type);
    if (entry?.def.kind !== 'data' || active.has(key)) return {};
    const def = entry.def;
    this.sources.set(key, entry.source.kind);
    const down = entry.unavailable?.() ?? null;
    if (down !== null && n.bypassed !== true) {
      return this.fail(n.id, path, 'data', `${title(n, def)} can't run: ${down}`);
    }
    active.add(key);
    const startedAt = this.deps.now();
    const ports = def.outputs.filter((p) => p.type.startsWith('data:')).map((p) => p.id);
    /** One output: the value as is. Several: an object keyed by output id (see DataResult). */
    const spread = (value: DataValue): { values: Record<string, DataValue>; keyed: boolean } => {
      if (ports.length <= 1) {
        return { values: Object.fromEntries(ports.map((p) => [p, value])), keyed: true };
      }
      const keyed = typeof value === 'object' && value !== null && !Array.isArray(value);
      const pick = (p: string): DataValue =>
        keyed && Object.hasOwn(value, p) ? (value[p] ?? 'unknown') : 'unknown';
      return { values: Object.fromEntries(ports.map((p) => [p, pick(p)])), keyed };
    };
    let value: DataValue = 'unknown';
    let reason: string;
    let returned = false;
    if (n.bypassed === true) reason = this.bypassReason(n);
    else if (!def.data) reason = 'no-op';
    else {
      try {
        const settings = this.settings(def, n);
        const data = await this.dataFor(n, def, graph, path, active);
        const result = await def.data(this.base(n, data), settings);
        value = result.value;
        reason = result.reason;
        returned = true;
      } catch (err) {
        if (err instanceof WalkFailed) throw err;
        reason = `source unavailable: ${message(err)}`;
      }
    }
    const { values, keyed } = spread(value);
    if (returned && !keyed) reason += ' (expected an object keyed by output id)';
    this.memo.set(key, values);
    active.delete(key);
    this.trace(n.id, path, 'data', startedAt, { port: null, reason, findings: values });
    return values;
  }

  /**
   * Walks `graph` from `startId`, appending to `steps`. 'end': an End node was reached (a
   * sub-workflow hands the file back on `returnPort`, the Run node's output); 'stopped': the path
   * ended (an unconnected output).
   */
  async decide(
    graph: WorkflowGraph,
    path: string[],
    startId: string,
    children: string[],
    returnPort: string | null,
  ): Promise<'end' | 'stopped'> {
    const seen = new Set<string>();
    let id = startId;
    for (;;) {
      const ref: NodeRef = { nodeId: id, workflowPath: path, graph, port: null };
      this.steps.push(ref);
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) return this.fail(id, path, 'pass', `node ${id} is missing`);
      if (seen.has(id)) this.fail(id, path, 'pass', 'the workflow has a cycle');
      seen.add(id);
      this.deps.onNodeStart?.({ workflowPath: [...path], nodeId: id });
      if (n.type === SUBWORKFLOW_END_TYPE) {
        ref.port = returnPort;
        this.note(id, path, 'pass', returnPort, 'returns');
        return 'end';
      }
      const def = this.def(n, path);
      const outputs = fileOutputs(def, n);
      let port: string | null = outputs[0] ?? null;
      const phase: Phase = def.kind === 'condition' ? 'decide' : 'pass';
      if (n.bypassed === true && !PASS_KINDS.has(def.kind)) {
        // Bypassed: no hook; the file passes on the first file output (as validation assumes).
        // Actions and finish nodes (a Run node too: it is not entered) are traced in the build.
        if (def.kind === 'condition') {
          this.note(id, path, 'decide', port, this.bypassReason(n));
        }
      } else if (def.kind === 'trigger') {
        this.note(id, path, 'pass', port, `start: ${title(n, def)}`);
      } else if (n.type === SUBWORKFLOW_START_TYPE) {
        this.note(id, path, 'pass', port, 'start');
      } else if (n.type === RUN_SUBWORKFLOW_TYPE) {
        // The Run node has a file input only (no data inputs to resolve).
        const s = RunSubworkflowSettingsSchema.safeParse(n.settings);
        if (!s.success) this.fail(id, path, 'pass', 'invalid settings: sub-workflow reference');
        const { subworkflowId, version, overrides } = s.data;
        if (children.includes(subworkflowId)) {
          this.fail(id, path, 'pass', 'sub-workflow calls itself');
        }
        const child =
          this.deps.resolveChild(subworkflowId, version, overrides) ??
          this.fail(id, path, 'pass', 'sub-workflow missing');
        const start =
          child.graph.nodes.find((x) => x.type === SUBWORKFLOW_START_TYPE) ??
          this.fail(id, path, 'pass', 'sub-workflow has no start');
        ref.port = port;
        this.note(id, path, 'pass', port, `enters sub-workflow ${child.name} v${version}`);
        const ended = await this.decide(
          child.graph,
          [...path, id],
          start.id,
          [...children, subworkflowId],
          port,
        );
        if (ended === 'stopped') return 'stopped';
      } else if (def.kind === 'condition') {
        const data = await this.dataFor(n, def, graph, path);
        if (!def.decide) {
          this.note(id, path, 'decide', port, 'no-op');
        } else {
          const decideHook = def.decide;
          const result = await this.hook(
            n,
            path,
            'decide',
            async () => {
              const r = await decideHook(
                { ...this.base(n, data), now: this.deps.now().getTime() },
                this.settings(def, n),
              );
              if (!outputs.includes(r.port)) throw new Error(`chose unknown port ${r.port}`);
              return r;
            },
            (r) => ({ port: r.port, reason: r.reason, findings: r.findings ?? {} }),
          );
          port = result.port;
          if (n.type === CHECK_SOURCE_TYPE && port === CHECK_SOURCE_DAMAGED_PORT) {
            // Only finish steps follow (validation); none renders or writes (the build).
            if (path.length > 0) this.fail(id, path, 'decide', CHECK_SOURCE_NESTED_TEXT);
            const f = result.findings ?? {};
            const stream = typeof f.stream === 'string' ? f.stream : undefined;
            this.sourceDamagedAt = {
              nodeId: id,
              damage: {
                reason: typeof f.reason === 'string' ? f.reason : result.reason,
                ...(stream !== undefined ? { stream } : {}),
              },
            };
          }
        }
      } else if (def.kind === 'action' || def.kind === 'finish') {
        // Resolved now so data entries precede the build entries; the build reads the memo.
        await this.dataFor(n, def, graph, path);
        // The file continues by `pass` (the first output); what the gate's `else` leads to is
        // walked apart, since only a gate that fails takes it. Render's Damaged likewise.
        await this.decideBranches(graph, path, n, def);
      }
      ref.port = port;
      if (port === null) return 'stopped';
      const next = graph.edges.filter((e) => e.from.node === id && e.from.port === port);
      if (next.length === 0) return 'stopped';
      if (next.length > 1) {
        // Only finish nodes may share an output: they all act on the one result, so they run
        // one after the other, in phase order (see finishOrder). The path ends with them.
        const shared = `output ${port} has ${next.length} connections; only finish steps can share an output`;
        const refs = this.finishOrder(graph, path, next, seen, (to, first) =>
          first ? this.fail(id, path, phase, shared) : this.notAfterFinish(to, path),
        );
        for (const ref of refs) {
          this.steps.push(ref);
          // A gate decides for the steps after it; its siblings would run whatever it decides.
          const n = graph.nodes.find((x) => x.id === ref.nodeId);
          if (n?.type === SIZE_GATE_TYPE && n.bypassed !== true) {
            this.fail(ref.nodeId, path, 'pass', SIZE_GATE_SHARED_TEXT);
          }
          await this.decideFinish(ref);
        }
        return 'stopped';
      }
      id = (next[0] as (typeof next)[number]).to.node;
    }
  }

  /** Fails the walk at a node that is not a finish node but follows one. */
  private notAfterFinish(n: NodeInstance, path: string[]): never {
    const entry = this.deps.registry.get(n.type);
    const name = entry ? title(n, entry.def) : n.type;
    return this.fail(
      n.id,
      path,
      'pass',
      `${name} comes after a finish node; only finish nodes may follow one`,
    );
  }

  /** The decide-phase work of a finish node off a shared output: its data, a gate's `else`. */
  private async decideFinish(ref: NodeRef): Promise<void> {
    const { graph, workflowPath: path, nodeId: id } = ref;
    const n = graph.nodes.find((x) => x.id === id) as NodeInstance;
    this.deps.onNodeStart?.({ workflowPath: [...path], nodeId: id });
    if (n.bypassed === true) return;
    const def = this.def(n, path);
    await this.dataFor(n, def, graph, path);
    await this.decideBranches(graph, path, n, def);
  }

  /** The side branches of a running finish node: a size gate's `else`, Render's Damaged. */
  private async decideBranches(
    graph: WorkflowGraph,
    path: string[],
    n: NodeInstance,
    def: AnyNodeDefinition,
  ): Promise<void> {
    if (n.type === SIZE_GATE_TYPE) {
      this.elseSteps.set(n.id, await this.decideBranch(graph, path, n.id, SIZE_GATE_ELSE_PORT));
    } else if (path.length === 0 && checksQuality(def, n)) {
      // Render is not allowed in sub-workflows (validation); only a top-level one has a branch.
      this.damagedSteps.set(
        n.id,
        await this.decideBranch(graph, path, n.id, RENDER_DAMAGED_PORT, 'damaged'),
      );
    }
  }

  /**
   * The finish nodes reachable from `starts` (the connections of one output), in the order they
   * run: as if chained in finish-phase order (render → gate → write → library manager → media
   * server → notify). A node runs after the finish nodes wired before it; among the nodes free to run, the
   * lower phase goes first, then the one further left on the canvas (`position.x`), then the
   * higher one (`position.y`), then the one earlier in `graph.nodes`. A node follows the output
   * a file leaves it by (a gate: `pass`; bypassed: its first). `bad(n, first)` fails the walk at
   * a node that is not a finish node (`first`: it is one of `starts`).
   */
  private finishOrder(
    graph: WorkflowGraph,
    path: string[],
    starts: Edge[],
    seen: ReadonlySet<string>,
    bad: (n: NodeInstance, first: boolean) => never,
  ): NodeRef[] {
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    const found = new Map<string, { order: number[]; port: string | null }>();
    const into = new Map<string, number>();
    const after = new Map<string, string[]>();
    const work = starts.map((e) => ({ id: e.to.node, first: true }));
    for (const s of starts) into.set(s.to.node, 0);
    for (let item = work.shift(); item !== undefined; item = work.shift()) {
      const { id, first } = item;
      if (found.has(id)) continue;
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) return this.fail(id, path, 'pass', `node ${id} is missing`);
      if (seen.has(id)) this.fail(id, path, 'pass', 'the workflow has a cycle');
      const def = this.def(n, path);
      if (def.kind !== 'finish') bad(n, first);
      // A finish node without a phase (none in core or a plugin) runs last.
      const rank = def.finishPhase ? finishPhaseRank(def.finishPhase) : FINISH_PHASES.length;
      const port = fileOutputs(def, n)[0] ?? null;
      const { x, y } = n.position;
      found.set(id, { order: [rank, x, y, index.get(id) ?? 0], port });
      const next =
        port === null ? [] : graph.edges.filter((e) => e.from.node === id && e.from.port === port);
      after.set(
        id,
        next.map((e) => e.to.node),
      );
      for (const e of next) {
        into.set(e.to.node, (into.get(e.to.node) ?? 0) + 1);
        work.push({ id: e.to.node, first: false });
      }
    }
    const refs: NodeRef[] = [];
    const ready = [...found.keys()].filter((id) => (into.get(id) ?? 0) === 0);
    const order = (id: string) => (found.get(id) as { order: number[] }).order;
    const before = (a: string, b: string) => {
      const [oa, ob] = [order(a), order(b)];
      for (const [i, v] of oa.entries()) if (v !== ob[i]) return v - (ob[i] as number);
      return 0;
    };
    while (ready.length > 0) {
      ready.sort(before);
      const id = ready.shift() as string;
      const { port } = found.get(id) as { port: string | null };
      refs.push({ nodeId: id, workflowPath: [...path], graph, port });
      for (const to of after.get(id) ?? []) {
        const left = (into.get(to) ?? 0) - 1;
        into.set(to, left);
        if (left === 0) ready.push(to);
      }
    }
    if (refs.length < found.size) {
      const stuck = [...found.keys()].find((id) => !refs.some((r) => r.nodeId === id)) as string;
      this.fail(stuck, path, 'pass', 'the workflow has a cycle');
    }
    return refs;
  }

  /**
   * The finish nodes behind `nodeId`'s `port` (a gate's `else`, Render's Damaged), in the order
   * they run (several may share the output: see finishOrder). Their data is resolved now, like
   * the main path's.
   */
  private async decideBranch(
    graph: WorkflowGraph,
    path: string[],
    nodeId: string,
    port: string,
    where: NoWrite = 'else',
  ): Promise<NodeRef[]> {
    const starts = graph.edges.filter((e) => e.from.node === nodeId && e.from.port === port);
    if (starts.length === 0) return [];
    const refs = this.finishOrder(graph, path, starts, new Set([nodeId]), (n) =>
      this.fail(n.id, path, 'pass', `only finish steps can follow ${NO_WRITE_WHERE[where]}`),
    );
    for (const ref of refs) {
      const n = graph.nodes.find((x) => x.id === ref.nodeId) as NodeInstance;
      this.deps.onNodeStart?.({ workflowPath: [...path], nodeId: ref.nodeId });
      await this.dataFor(n, this.def(n, path), graph, path);
    }
    return refs;
  }

  /**
   * The build hooks along `nodes`, collecting finish actions into `run.actions`. `run.noWrite`:
   * the nodes sit behind a size gate's `else` or Render's Damaged (after `run.prefix`, the path
   * walked so far), where nothing may render, gate or write the result.
   */
  async build(
    nodes: NodeRef[],
    run: {
      model: BuildModel;
      actions: AnyFinishAction[];
      prefix?: NodeRef[];
      noWrite?: NoWrite;
    } = { model: modelFromProbe(this.input.probe), actions: [] },
  ): Promise<{ model: BuildModel; actions: AnyFinishAction[]; autoPicks: AutoPick[] }> {
    let { model } = run;
    const { actions } = run;
    const autoPicks: AutoPick[] = [];
    for (const [i, ref] of nodes.entries()) {
      this.steps = [...(run.prefix ?? []), ...nodes.slice(0, i + 1)];
      const { nodeId, workflowPath: path, graph, port } = ref;
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (!n) return this.fail(nodeId, path, 'build', 'node is missing');
      const def = this.def(n, path, 'build');
      if (def.kind !== 'action' && def.kind !== 'finish') continue;
      const bypassed = n.bypassed === true;
      // A Run node's work is its sub-workflow's nodes, which follow it in the path.
      if (n.type === RUN_SUBWORKFLOW_TYPE && !bypassed) continue;
      const builtBefore = def.kind === 'finish' ? this.finished.get(dataKey(path, nodeId)) : null;
      if (!builtBefore) this.deps.onNodeStart?.({ workflowPath: [...path], nodeId });
      const phase = def.kind === 'finish' ? 'finish' : 'build';
      if (bypassed) {
        if (builtBefore) continue;
        this.note(nodeId, path, phase, port, this.bypassReason(n));
        if (def.kind === 'finish') this.finished.set(dataKey(path, nodeId), []);
        continue;
      }
      if (
        run.noWrite !== undefined &&
        (def.kind !== 'finish' ||
          def.finishPhase === 'write' ||
          def.finishPhase === 'gate' ||
          def.finishPhase === 'render')
      ) {
        this.fail(
          nodeId,
          path,
          'finish',
          `a step that writes the result cannot follow ${NO_WRITE_WHERE[run.noWrite]}`,
        );
      }
      if (builtBefore) {
        actions.push(...builtBefore);
        continue;
      }
      const data = await this.dataFor(n, def, graph, path);
      const ctx = { ...this.base(n, data), model };
      const firstAction = actions.length;
      if (n.type === SIZE_GATE_TYPE) this.gateIndex.set(nodeId, actions.length);
      if (n.type === RENDER_TYPE) this.renderIndex.set(nodeId, actions.length);
      if (def.kind === 'action' && def.build) {
        const buildHook = def.build;
        // Fail closed: anything that is not registered as a core node is guarded (a missing
        // registry entry too), whatever its definition looks like.
        const guarded = this.deps.registry.get(n.type)?.source.kind !== 'core';
        const before = guarded ? inputFilesOf(model) : '';
        // Read inside the hook, so a settings error fails the step like a hook error does.
        let settings: Record<string, JsonValue> = {};
        const result = await this.hook(
          n,
          path,
          'build',
          async () => {
            settings = this.settings(def, n);
            const built = await buildHook(ctx, settings);
            // Only core nodes choose input files: a plugin could otherwise make ffmpeg read any path.
            if (
              guarded &&
              (inputFilesOf(built.model) !== before || repointsSourceStream(built.model))
            ) {
              throw new Error('plugin build hooks cannot change input files');
            }
            return built;
          },
          (r) => ({
            port,
            reason: r.reason,
            findings: r.findings ?? {},
            changes: modelChanges(model, r.model),
          }),
        );
        if (
          n.type === ENCODE_VIDEO_TYPE &&
          run.noWrite === undefined &&
          settings.encoder === 'auto'
        ) {
          autoPicks.push(...picksOf(model, result.model));
        }
        model = result.model;
      } else if (def.kind === 'finish' && def.finish) {
        const finishHook = def.finish;
        const settings = this.settings(def, n);
        // Findings stay empty: finish actions may carry secrets (a notify URL).
        const result = await this.hook(
          n,
          path,
          'finish',
          async () => finishHook(ctx, settings),
          (r) => ({ port, reason: r.reason, findings: {} }),
        );
        if (this.deps.registry.get(n.type)?.source.kind === 'plugin') {
          const phase = def.finishPhase;
          if (phase === undefined) {
            return this.fail(nodeId, path, 'finish', 'a plugin finish node has no phase');
          }
          for (const action of result.actions) {
            if (action.kind !== 'plugin') {
              return this.fail(
                nodeId,
                path,
                'finish',
                `a plugin node returned a ${action.kind} action`,
              );
            }
            actions.push({
              ...action,
              phase,
              nodeType: n.type,
              nodeVersion: n.typeVersion,
              nodeId,
              workflowPath: [...path],
              settings,
            });
          }
        } else {
          actions.push(...result.actions);
        }
        this.finished.set(dataKey(path, nodeId), actions.slice(firstAction));
      } else {
        this.note(nodeId, path, phase, port, 'no-op');
        if (def.kind === 'finish') this.finished.set(dataKey(path, nodeId), []);
      }
    }
    return { model, actions, autoPicks };
  }
}

/**
 * The kept video streams in convert mode that `after` encodes differently from `before`: a new
 * encoder, or newly converted. Streams match by source index and input file.
 */
function picksOf(before: BuildModel, after: BuildModel): AutoPick[] {
  const picks: AutoPick[] = [];
  for (const s of after.streams) {
    if (!(s.keep && s.type === 'video' && s.mode === 'convert' && s.encoder !== null)) continue;
    const input = s.input ?? 0;
    const was = before.streams.find(
      (b) => b.sourceIndex === s.sourceIndex && (b.input ?? 0) === input,
    );
    if (was?.mode === 'convert' && was.encoder === s.encoder) continue;
    picks.push({ sourceIndex: s.sourceIndex, input, encoder: s.encoder });
  }
  return picks;
}

async function guarded<T>(walker: Walker, run: () => Promise<T>): Promise<T | WalkFailure> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof WalkFailed)) throw err;
    const { nodeId, workflowPath, reason, retryable } = err;
    return {
      kind: 'failed',
      nodeId,
      workflowPath,
      reason,
      path: walker.steps.map(step),
      retryable,
    };
  }
}

/** Phase 1: the path of the file from the single trigger, choosing ports at conditions. */
export async function walkDecide(
  deps: WalkDeps,
  input: WalkInput,
): Promise<DecidedPath | WalkFailure> {
  const memo: DataMemo = new Map();
  const walker = new Walker(deps, input, memo, input.firstSeq ?? 1);
  return guarded(walker, async () => {
    const triggers = input.graph.nodes.filter(
      (n) => deps.registry.get(n.type)?.def.kind === 'trigger',
    );
    if (triggers.length !== 1) {
      // No node to trace on: a loaded (validated) workflow never gets here.
      throw new WalkFailed(
        '',
        [],
        `the workflow has ${triggers.length} triggers; it needs exactly one`,
      );
    }
    await walker.decide(input.graph, [], (triggers[0] as NodeInstance).id, [], null);
    return {
      kind: 'decided' as const,
      nodes: walker.steps,
      elseNodes: walker.elseSteps,
      damagedNodes: walker.damagedSteps,
      sourceDamagedAt: walker.sourceDamagedAt,
      data: memo,
      nextSeq: walker.seq,
    };
  });
}

/** Phase 2: the build hooks along the decided path, then the finish actions, in path order. */
export async function walkBuild(
  deps: WalkDeps,
  input: WalkInput,
  decided: DecidedPath,
): Promise<WalkResult> {
  const walker = new Walker(deps, input, decided.data, decided.nextSeq);
  return guarded(walker, async () => {
    // Below a Check source's Damaged nothing renders or writes: the steps after it build apart.
    const at = decided.sourceDamagedAt
      ? decided.nodes.findIndex(
          (r) => r.workflowPath.length === 0 && r.nodeId === decided.sourceDamagedAt?.nodeId,
        )
      : -1;
    const head = at >= 0 ? decided.nodes.slice(0, at + 1) : decided.nodes;
    const { model, actions, autoPicks } = await walker.build(head, {
      model: modelFromProbe(input.probe),
      actions: [],
    });
    if (at >= 0) {
      await walker.build(decided.nodes.slice(at + 1), {
        model,
        actions,
        prefix: head,
        noWrite: 'source',
      });
    }
    // The finish steps behind each gate's `else`, built with the model the pass path ended on.
    const gates: GateBranch[] = [];
    for (const [nodeId, refs] of decided.elseNodes) {
      const actionIndex = walker.gateIndex.get(nodeId);
      if (actionIndex === undefined) continue; // a bypassed gate runs no hook, so it never fails
      const built = await walker.build(refs, {
        model,
        actions: [],
        prefix: decided.nodes,
        noWrite: 'else',
      });
      gates.push({
        nodeId,
        actionIndex,
        elseActions: built.actions,
        elsePath: refs.map(step),
      });
    }
    // The steps behind Render's Damaged, likewise; a path renders once (validation), so the first.
    let damaged: DamagedBranch | null = null;
    for (const [nodeId, refs] of decided.damagedNodes) {
      const actionIndex = walker.renderIndex.get(nodeId);
      if (actionIndex === undefined || refs.length === 0 || damaged !== null) continue;
      const built = await walker.build(refs, {
        model,
        actions: [],
        prefix: decided.nodes,
        noWrite: 'damaged',
      });
      damaged = { nodeId, actionIndex, actions: built.actions, path: refs.map(step) };
    }
    return {
      kind: 'built' as const,
      model,
      actions,
      gates,
      damaged,
      sourceDamagedAt: at >= 0 ? decided.sourceDamagedAt : null,
      path: decided.nodes.map(step),
      autoPicks,
    };
  });
}

/** @internal Test helper: both phases at once (the pipeline runs them separately). */
export async function walk(deps: WalkDeps, input: WalkInput): Promise<WalkResult> {
  const decided = await walkDecide(deps, input);
  if (decided.kind === 'failed') return decided;
  return walkBuild(deps, input, decided);
}
