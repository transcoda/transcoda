// A job's trace drawn over a workflow graph (pure). The engine's walk (`JobDetail.path`) is the
// taken path: step N left by its `port` to step N+1 at the same level, and a sub-workflow's End
// step is the Run node leaving by that port. Trace entries give each node its reason and findings
// (latest attempt per node; within it, the last `failed:` entry wins). Data entries feed the value
// labels on data edges and are never path nodes.
import type { WalkStep } from '@transcoda/contract';
import {
  isFinalState,
  type JobState,
  type JsonValue,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  type TraceChanges,
  type TraceEntry,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { Catalog } from '../../hooks/useCatalog.ts';
import type { TraceNodeData, TraceOverlay } from '../flow/types.ts';

export type { TraceNodeData, TraceOverlay };

/** The node a job is at, as `job.changed` reports it. */
export type CurrentNode = { workflowPath: string[]; nodeId: string };

export interface TraceSource {
  trace: TraceEntry[];
  /** `JobDetail.path`. */
  steps: WalkStep[];
  jobState: JobState;
  /**
   * From the latest `job.changed`: null means "at no node" (replacing, finished); undefined means
   * no event yet, and the last traced node stands in while the job is active.
   */
  currentNode: CurrentNode | null | undefined;
}

const FAILED = 'failed:';

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function startsWith(a: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= a.length && prefix.every((x, i) => x === a[i]);
}

/** The key of a graph level: Run-node ids from the top down joined by "/" ("" at top level). */
export function pathKey(workflowPath: readonly string[]): string {
  return workflowPath.join('/');
}

/** A finding as an edge label: strings as they are, anything else as JSON. */
export function findingText(v: JsonValue): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const SIZE_GATE_TYPE = 'core:size-gate';

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Per node and attempt: `<path>#<node>#<attempt>`. */
const attemptKey = (e: TraceEntry): string => `${pathKey(e.workflowPath)}#${e.nodeId}#${e.attempt}`;

/**
 * The size gate's decision entries per node and attempt: its finish entries after the first (the
 * first is the build's "at least N% smaller"), failures left out. Without one the job settled
 * before the gate was evaluated, so no branch was taken. A plugin's entries are never a gate's (a
 * plugin finish step's second entry is its own answer, see `superseded`).
 */
export function gateDecisions(trace: readonly TraceEntry[]): Map<string, TraceEntry> {
  const byKey = new Map<string, TraceEntry[]>();
  for (const e of [...trace].sort((a, b) => a.seq - b.seq)) {
    if (e.phase !== 'finish' || e.source === 'plugin' || e.reason.startsWith(FAILED)) continue;
    const key = attemptKey(e);
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const out = new Map<string, TraceEntry>();
  for (const [key, list] of byKey) {
    const last = list.at(-1);
    if (last && list.length > 1) out.set(key, last);
  }
  return out;
}

/**
 * A plugin finish step's planned entries ("rescan after the write") that its own answer, written
 * after the step ran ("Radarr lists …", or `failed: …`), stands in for (C2): every plugin finish
 * entry of a node and attempt but the last.
 */
function superseded(trace: readonly TraceEntry[]): Set<TraceEntry> {
  const last = new Map<string, TraceEntry>();
  for (const e of trace) {
    if (e.phase !== 'finish' || e.source !== 'plugin') continue;
    const key = attemptKey(e);
    const seen = last.get(key);
    if (!seen || e.seq > seen.seq) last.set(key, e);
  }
  const out = new Set<TraceEntry>();
  for (const e of trace) {
    if (e.phase === 'finish' && e.source === 'plugin' && last.get(attemptKey(e)) !== e) out.add(e);
  }
  return out;
}

type Authoritative = { entry: TraceEntry; retried: boolean };

/** Per node at `path`: the entry that speaks for it (latest attempt; last failed: entry wins). */
function entriesAt(trace: TraceEntry[], path: readonly string[]): Map<string, Authoritative> {
  const byNode = new Map<string, TraceEntry[]>();
  for (const e of trace) {
    if (!samePath(e.workflowPath, path)) continue;
    const list = byNode.get(e.nodeId);
    if (list) list.push(e);
    else byNode.set(e.nodeId, [e]);
  }
  const out = new Map<string, Authoritative>();
  for (const [id, list] of byNode) {
    const attempt = Math.max(...list.map((e) => e.attempt));
    const latest = list.filter((e) => e.attempt === attempt).sort((a, b) => a.seq - b.seq);
    const failed = latest.filter((e) => e.reason.startsWith(FAILED)).at(-1);
    const entry = failed ?? latest.at(-1);
    if (entry) out.set(id, { entry, retried: list.some((e) => e.attempt < attempt) });
  }
  return out;
}

/**
 * The node the job is at: the reported one, or (no event yet) the last traced node; none while
 * the job is queued or once it is final.
 */
export function currentNodeOf(source: TraceSource): CurrentNode | null {
  if (isFinalState(source.jobState) || source.jobState === 'queued') return null;
  if (source.currentNode !== undefined) return source.currentNode;
  const last = [...source.trace]
    .filter((e) => e.phase !== 'data')
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  return last ? { workflowPath: last.workflowPath, nodeId: last.nodeId } : null;
}

/** The node of `path` the job is at: the node itself, or the Run node whose sub-workflow holds it. */
function currentAt(source: TraceSource, path: readonly string[]): string | null {
  const at = currentNodeOf(source);
  if (!at || !startsWith(at.workflowPath, path)) return null;
  return at.workflowPath.length === path.length
    ? at.nodeId
    : (at.workflowPath[path.length] ?? null);
}

/** Taken edges at `path` (edge id → leaving port) from the walk. */
function takenAt(
  graph: WorkflowGraph,
  steps: WalkStep[],
  path: readonly string[],
): { edges: Set<string>; leave: Map<string, string | null>; onPath: Set<string> } {
  const edges = new Set<string>();
  const leave = new Map<string, string | null>();
  const onPath = new Set<string>();
  const level = steps.flatMap((s, i) => (samePath(s.workflowPath, path) ? [i] : []));
  for (const [k, i] of level.entries()) {
    const step = steps[i] as WalkStep;
    onPath.add(step.nodeId);
    const j = level[k + 1];
    // A sub-workflow in between: its last step (the End) is the Run node leaving by that port.
    const port = j !== undefined && j > i + 1 ? (steps[j - 1]?.port ?? step.port) : step.port;
    leave.set(step.nodeId, port);
    if (j === undefined) continue;
    const next = (steps[j] as WalkStep).nodeId;
    const from = graph.edges.filter((e) => e.from.node === step.nodeId && e.to.node === next);
    const edge = from.find((e) => e.from.port === port) ?? from[0];
    if (edge) edges.add(edge.id);
    // A step that left by no port yet has a next step: a size gate in a dry run, whose result
    // is not known. Every branch it has on the walk is possible.
    if (port === null) {
      for (const later of level.slice(k + 1)) {
        const to = (steps[later] as WalkStep).nodeId;
        for (const e of graph.edges)
          if (e.from.node === step.nodeId && e.to.node === to) edges.add(e.id);
      }
    }
  }
  return { edges, leave, onPath };
}

/** The nodes behind the else of a size gate on the walk that has no decision entry, off the walk. */
function undecidedElse(
  graph: WorkflowGraph,
  trace: readonly TraceEntry[],
  entries: Map<string, Authoritative>,
  onPath: ReadonlySet<string>,
): Set<string> {
  const decided = gateDecisions(trace);
  const out = new Set<string>();
  for (const gate of graph.nodes) {
    if (gate.type !== SIZE_GATE_TYPE || !onPath.has(gate.id)) continue;
    const attempt = entries.get(gate.id)?.entry.attempt ?? 1;
    if (decided.has(`#${gate.id}#${attempt}`)) continue;
    const queue = graph.edges
      .filter((e) => e.from.node === gate.id && e.from.port === 'else')
      .map((e) => e.to.node);
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (out.has(id) || onPath.has(id)) continue;
      out.add(id);
      for (const e of graph.edges) if (e.from.node === id) queue.push(e.to.node);
    }
  }
  return out;
}

/**
 * The overlay for the graph at `path` (Run-node ids from the top level down; [] for the job's
 * own workflow). Nodes the walk reached are `done` (`current` for the node the job is at, `failed`
 * when their last entry failed); nodes never reached are `pending` while the job is active and
 * `untaken` once it is final. Data nodes are `done` once evaluated.
 */
export function buildTraceOverlay(
  graph: WorkflowGraph,
  source: TraceSource,
  path: readonly string[],
): TraceOverlay {
  const final = isFinalState(source.jobState);
  const entries = entriesAt(source.trace, path);
  const { edges: taken, leave, onPath } = takenAt(graph, source.steps, path);
  const current = currentAt(source, path);

  // A gate the job never reached (it failed or stopped earlier): no branch was taken, so what
  // hangs off its else is neither shown as taken nor dimmed as untaken while the pass chain is.
  const undecided = undecidedElse(graph, source.trace, entries, onPath);

  const nodes = new Map<string, TraceNodeData>();
  for (const n of graph.nodes) {
    const found = entries.get(n.id);
    const entry = found?.entry;
    const isData = entry?.phase === 'data';
    let status: TraceNodeData['status'];
    if (entry?.reason.startsWith(FAILED)) status = 'failed';
    else if (current === n.id) status = 'current';
    else if (isData || (onPath.has(n.id) && entry)) status = 'done';
    else status = final && !undecided.has(n.id) ? 'untaken' : 'pending';
    const reached = status === 'done' || status === 'current' || status === 'failed';
    nodes.set(n.id, {
      status,
      reason: reached ? (entry?.reason ?? null) : null,
      port: reached ? (leave.get(n.id) ?? entry?.port ?? null) : null,
      findings: reached ? (entry?.findings ?? {}) : {},
      attempt: entry?.attempt ?? 1,
      retried: found?.retried ?? false,
      ...(reached && entry?.source === 'plugin' ? { plugin: true } : {}),
    });
  }

  const edges: TraceOverlay['edges'] = new Map();
  for (const e of graph.edges) {
    const source = entries.get(e.from.node)?.entry;
    if (source?.phase === 'data') {
      const v = source.findings[e.from.port];
      edges.set(e.id, {
        taken: false,
        untaken: false,
        value: v === undefined ? null : findingText(v),
      });
      continue;
    }
    const isTaken = taken.has(e.id);
    const from = nodes.get(e.from.node)?.status;
    const leftOther = from === 'done' || from === 'failed' || final;
    const open = undecided.has(e.to.node);
    edges.set(e.id, { taken: isTaken, untaken: !isTaken && leftOther && !open, value: null });
  }
  return { nodes, edges, currentNodeId: current };
}

export interface Decision {
  key: string;
  attempt: number;
  depth: number;
  title: string;
  reason: string;
  findings: Record<string, JsonValue>;
  nodeId: string;
  workflowPath: string[];
  /** The node's kind for the list's swatch; null when the node or its type is unknown. */
  kind: string | null;
  /** The node's type ('core:keep-languages'); null when the node is not in the graph. */
  type: string | null;
  /** The node's settings as the graph holds them (defaults not filled in); {} when unknown. */
  settings: Record<string, JsonValue>;
  phase: TraceEntry['phase'];
  /** What the step changed in the output (`TraceEntry.changes`); null when the entry has none. */
  changes: TraceChanges | null;
  /** Inside a sub-workflow: the Run node's title (`runTitle`); null at the top level. */
  within: string | null;
  /** The entry was written by a plugin node. */
  plugin: boolean;
  /** The port the node left by ('pass', 'else', 'file' …); null when it left by none (the Decisions list words conditions by it). */
  port: string | null;
  /**
   * Which way a size gate went, on its decision entry only: 'depends' in a dry run (the result
   * is not known). null on every other entry, including the gate's build entry.
   */
  branch: 'pass' | 'else' | 'depends' | null;
  /**
   * A finish step of the branch the file did not take (a size gate's other output), once the job
   * is settled; the list dims it.
   */
  untaken: boolean;
}

/**
 * Screen 06 "Decisions, in order": every trace entry, titled by the node's label or its type's
 * title. A sub-workflow's Start and End say nothing and are left out. `children` holds the
 * sub-workflow graphs by `pathKey` of their Run node ("run-a", "run-a/run-x").
 *
 * With the walk (`steps`, `JobDetail.path`) the entries follow the file's path: the engine traces
 * the decide phase (conditions, Run nodes) before the build phase (actions), so in trace order a
 * Run node behind an Encode video would come first and its sub-workflow's actions would read as
 * part of the encode. Within an attempt each entry takes its node's first position on the walk; an
 * entry off the walk stays right after the entry before it. Without `steps`, trace order.
 */
export function decisions(
  trace: TraceEntry[],
  graph: WorkflowGraph,
  catalog: Catalog | null,
  children: ReadonlyMap<string, WorkflowGraph | null | undefined>,
  steps?: readonly WalkStep[],
  names: ReadonlyMap<string, string> = new Map(),
  /** The job is final: a finish step off its walk belongs to a branch that was not taken. */
  settled = false,
): Decision[] {
  const out: Decision[] = [];
  const decided = gateDecisions(trace);
  const decidedEntries = new Set(decided.values());
  /** Attempts in which a gate was evaluated: only then is an off-walk finish step "not taken". */
  const evaluated = new Set([...decided.values()].map((e) => e.attempt));
  const onWalk = new Set((steps ?? []).map((s) => `${pathKey(s.workflowPath)}#${s.nodeId}`));
  const answered = superseded(trace);
  for (const e of inWalkOrder(trace, steps)) {
    if (answered.has(e)) continue;
    const g = e.workflowPath.length === 0 ? graph : children.get(pathKey(e.workflowPath));
    const node = g?.nodes.find((n) => n.id === e.nodeId);
    if (node) {
      if (node.type === SUBWORKFLOW_START_TYPE || node.type === SUBWORKFLOW_END_TYPE) continue;
    } else if (
      e.workflowPath.length > 0 &&
      e.phase === 'pass' &&
      (e.reason === 'start' || e.reason === 'returns')
    ) {
      continue;
    }
    const def = node ? catalog?.byType.get(node.type) : undefined;
    out.push({
      key: String(e.seq),
      attempt: e.attempt,
      depth: e.workflowPath.length,
      title: node?.label ?? def?.title ?? e.nodeId,
      reason: e.reason,
      findings: e.findings,
      nodeId: e.nodeId,
      workflowPath: e.workflowPath,
      kind: def?.kind ?? null,
      type: node?.type ?? null,
      settings: isRecord(node?.settings) ? node.settings : {},
      phase: e.phase,
      changes: e.changes ?? null,
      plugin: e.source === 'plugin',
      port: e.port,
      branch: decidedEntries.has(e)
        ? e.port === 'pass' || e.port === 'else'
          ? e.port
          : 'depends'
        : null,
      untaken:
        settled &&
        evaluated.has(e.attempt) &&
        onWalk.size > 0 &&
        e.phase === 'finish' &&
        !onWalk.has(`${pathKey(e.workflowPath)}#${e.nodeId}`),
      within:
        e.workflowPath.length > 0
          ? runTitle(e.workflowPath, graph, children, catalog, names)
          : null,
    });
  }
  return out;
}

/** Trace entries by attempt, then by their node's first step on the walk, then by `seq`. */
function inWalkOrder(trace: TraceEntry[], steps: readonly WalkStep[] | undefined): TraceEntry[] {
  const bySeq = [...trace].sort((a, b) => a.seq - b.seq);
  if (!steps || steps.length === 0) return bySeq;
  const position = new Map<string, number>();
  steps.forEach((s, i) => {
    const key = `${pathKey(s.workflowPath)}#${s.nodeId}`;
    if (!position.has(key)) position.set(key, i);
  });
  const rank = new Map<TraceEntry, number>();
  let last = -1;
  for (const e of bySeq) {
    const at = position.get(`${pathKey(e.workflowPath)}#${e.nodeId}`);
    // Off the walk: just after the entry before it (a fraction keeps it behind that step).
    last = at ?? last + 0.001;
    rank.set(e, last);
  }
  // Array.prototype.sort is stable, so equal ranks keep their seq order.
  return bySeq.sort((a, b) => a.attempt - b.attempt || (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}

/** The graph at `path` ([] = the job's own workflow); undefined when it is not loaded. */
function graphAt(
  path: readonly string[],
  graph: WorkflowGraph,
  children: ReadonlyMap<string, WorkflowGraph | null | undefined>,
): WorkflowGraph | undefined {
  return path.length === 0 ? graph : (children.get(pathKey(path)) ?? undefined);
}

/**
 * The title of the Run node at the end of `path` (the sub-workflow that `path` opens): its label,
 * else the sub-workflow's name (`names`, by `pathKey`), else its type's title, else its id.
 */
export function runTitle(
  path: readonly string[],
  graph: WorkflowGraph,
  children: ReadonlyMap<string, WorkflowGraph | null | undefined>,
  catalog: Catalog | null,
  names: ReadonlyMap<string, string>,
): string {
  const id = path.at(-1) ?? '';
  const node = graphAt(path.slice(0, -1), graph, children)?.nodes.find((n) => n.id === id);
  return (
    node?.label ??
    names.get(pathKey(path)) ??
    (node ? catalog?.byType.get(node.type)?.title : undefined) ??
    id
  );
}

/** A node's title: its label, else its type's title, else its id. */
export function nodeTitle(
  ref: CurrentNode,
  graph: WorkflowGraph,
  children: ReadonlyMap<string, WorkflowGraph | null | undefined>,
  catalog: Catalog | null,
): string {
  const node = graphAt(ref.workflowPath, graph, children)?.nodes.find((n) => n.id === ref.nodeId);
  return node?.label ?? (node ? catalog?.byType.get(node.type)?.title : undefined) ?? ref.nodeId;
}

/** The node types that encode, in the order one stands for the encode of a job. */
const ENCODE_TYPES = ['core:encode-video', 'core:encode-audio', 'core:remux'] as const;

/**
 * The node that stands for a job's encode on its walk: Encode video, else Encode audio, else
 * Remux (the last one of that type the file passed, not bypassed); null when the walk has none.
 * While ffmpeg runs (encoding, verifying, replacing) the engine reports the last *built* node,
 * which is often a Run sub-workflow behind the encode; the page lights this node instead.
 */
export function encodeNode(
  steps: readonly WalkStep[],
  graph: WorkflowGraph,
  children: ReadonlyMap<string, WorkflowGraph | null | undefined>,
): CurrentNode | null {
  const typed = steps.flatMap((s) => {
    const node = graphAt(s.workflowPath, graph, children)?.nodes.find((n) => n.id === s.nodeId);
    return node && !node.bypassed ? [{ s, type: node.type }] : [];
  });
  for (const type of ENCODE_TYPES) {
    const hit = typed.filter((t) => t.type === type).at(-1);
    if (hit) return { workflowPath: [...hit.s.workflowPath], nodeId: hit.s.nodeId };
  }
  return null;
}
