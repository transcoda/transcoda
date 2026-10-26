import type { Issue, WorkflowGraph } from '@transcoda/shared';

/**
 * Server issues → what the canvas draws (design N6). Message-driven and tolerant of codes this
 * build does not know: the engine adds FINISH_ORDER, TARGET_UNSUPPORTED, ENCODER_UNAVAILABLE and
 * NO_WRITE_PATH, and any other new code renders as a generic error or warning by severity.
 */

export type NodeBadge =
  | 'plugin-missing'
  | 'plugin-stopped'
  | 'unknown-node'
  | 'unavailable'
  | 'needs-setting'
  | 'check-settings'
  | 'subworkflow-problem'
  | 'needs-connection'
  | 'unreachable'
  | 'not-allowed'
  | 'outdated-pin'
  | 'generic-error'
  | 'generic-warning'
  | null;

export type NodeBorder = 'red' | 'amber' | 'dashed' | null;

export interface NodeState {
  badge: NodeBadge;
  word: string | null;
  border: NodeBorder;
  dim: 0.6 | 0.7 | null;
  issues: Issue[];
  /** By `settingPath`, in server order. */
  fieldIssues: Map<string, Issue[]>;
  outdatedPinTo?: number;
}

export type EdgeState = { broken: boolean; issues: Issue[] };

/** The server's `INVALID_SETTINGS` message for a missing required value. */
export const NEEDS_A_SETTING = 'Needs a setting';

type Look = { badge: NodeBadge; word: string | null; border: NodeBorder; dim?: 0.6 | 0.7 };

const NONE: Look = { badge: null, word: null, border: null };

/**
 * The plugin a node type belongs to: 'jellyfin' for 'jellyfin:refresh'; null for core and
 * un-namespaced types. A type the server does not know is "plugin missing" when this names a
 * plugin (it is not installed), "unknown node" otherwise (design N6, Jan's ruling on question 2).
 */
export function missingPluginOf(type: string): string | null {
  const colon = type.indexOf(':');
  if (colon <= 0) return null;
  const namespace = type.slice(0, colon);
  return namespace === 'core' ? null : namespace;
}

/**
 * The type to pass to `nodeStateFor`: the node's type when its plugin is really absent (no
 * catalogue node shares its namespace), otherwise undefined, so a plugin that is installed but no
 * longer ships this node reads "unknown node" rather than "plugin missing". No catalogue yet → the
 * type (nothing is known to share the namespace).
 */
export function stateTypeFor(
  type: string,
  catalog: { nodes: ReadonlyArray<{ type: string }> } | null,
): string | undefined {
  const plugin = missingPluginOf(type);
  if (plugin === null) return type;
  const installed = catalog?.nodes.some((n) => missingPluginOf(n.type) === plugin) ?? false;
  return installed ? undefined : type;
}

function lookFor(issue: Issue, type: string | undefined): Look {
  const plugin = type !== undefined && missingPluginOf(type) !== null;
  switch (issue.code) {
    case 'UNKNOWN_NODE_TYPE':
      return plugin
        ? { badge: 'plugin-missing', word: 'plugin missing', border: 'red' }
        : { badge: 'unknown-node', word: 'unknown node', border: 'red' };
    case 'UNKNOWN_NODE_VERSION':
      // The type is known, this version of it is not: the installed plugin (or build) is older.
      return {
        badge: plugin ? 'plugin-missing' : 'unknown-node',
        word: 'needs a newer version',
        border: 'red',
      };
    case 'PLUGIN_UNAVAILABLE':
      return { badge: 'plugin-stopped', word: 'plugin not running', border: 'red' };
    case 'NODE_UNAVAILABLE':
    case 'ENCODER_UNAVAILABLE':
      return { badge: 'unavailable', word: 'not on this server', border: 'dashed', dim: 0.6 };
    case 'INVALID_SETTINGS':
      return issue.message === NEEDS_A_SETTING
        ? { badge: 'needs-setting', word: 'needs a setting', border: 'amber' }
        : { badge: 'check-settings', word: 'check settings', border: 'amber' };
    case 'INVALID_OVERRIDE':
    case 'TARGET_UNSUPPORTED':
      return { badge: 'check-settings', word: 'check settings', border: 'amber' };
    case 'SUBWORKFLOW_MISSING':
    case 'SUBWORKFLOW_REFERENCE_CYCLE':
    case 'SUBWORKFLOW_BROKEN':
      return { badge: 'subworkflow-problem', word: 'sub-workflow problem', border: 'red' };
    case 'INPUT_UNCONNECTED':
      return { badge: 'needs-connection', word: 'needs a connection', border: 'amber' };
    case 'NODE_NOT_ALLOWED_HERE':
    case 'FINISH_ORDER':
    case 'OUTPUT_MULTIPLE_EDGES':
    case 'OUTPUT_MULTIPLE_WRITES':
    case 'SIZE_GATE_SHARED_OUTPUT':
      return { badge: 'not-allowed', word: 'not allowed here', border: 'red' };
    case 'NODE_OUTDATED':
      // An inspector note; the server reports it as an error today, which blocks enabling.
      return issue.severity === 'error'
        ? { badge: null, word: 'update pending', border: 'red' }
        : NONE;
    case 'SUBWORKFLOW_OUTDATED':
      return { badge: 'outdated-pin', word: null, border: null };
    case 'NODE_UNREACHABLE':
      // A warning: the dashed outline and the word carry it (no amber). A node that is also
      // unconnected ranks amber and reads "needs a connection" instead (one badge per card).
      return { badge: 'unreachable', word: 'not reachable', border: 'dashed', dim: 0.7 };
    case 'OVERRIDE_DROPPED':
    case 'NO_WRITE_PATH':
      return NONE;
    default:
      return issue.severity === 'error'
        ? { badge: 'generic-error', word: 'error', border: 'red' }
        : { badge: 'generic-warning', word: 'warning', border: 'amber' };
  }
}

const BORDER_RANK: Record<Exclude<NodeBorder, null>, number> = { red: 3, amber: 2, dashed: 1 };

function rank(look: Look, issue: Issue): number {
  // Border level first, then errors before warnings; ties keep server order.
  return (look.border ? BORDER_RANK[look.border] : 0) * 2 + (issue.severity === 'error' ? 1 : 0);
}

const OUTDATED_PIN = /the latest is (\d+)/;

/** `type` is the node's type; without it a type the server does not know reads "unknown node". */
export function nodeStateFor(nodeId: string, issues: Issue[], type?: string): NodeState {
  const own = issues.filter((i) => i.nodeId === nodeId);
  const state: NodeState = {
    badge: null,
    word: null,
    border: null,
    dim: null,
    issues: own,
    fieldIssues: new Map(),
  };
  let best: { look: Look; rank: number } | null = null;
  for (const issue of own) {
    const look = lookFor(issue, type);
    if (look.dim !== undefined && (state.dim === null || look.dim < state.dim))
      state.dim = look.dim;
    if (issue.settingPath !== undefined && issue.code === 'INVALID_SETTINGS') {
      const list = state.fieldIssues.get(issue.settingPath);
      if (list) list.push(issue);
      else state.fieldIssues.set(issue.settingPath, [issue]);
    }
    if (issue.code === 'SUBWORKFLOW_OUTDATED' && state.outdatedPinTo === undefined) {
      const match = OUTDATED_PIN.exec(issue.message);
      if (match?.[1]) state.outdatedPinTo = Number(match[1]);
    }
    if (look.badge === null && look.word === null && look.border === null) continue;
    const r = rank(look, issue);
    if (!best || r > best.rank) best = { look, rank: r };
  }
  if (best) {
    state.badge = best.look.badge;
    state.word = best.look.word;
    state.border = best.look.border;
  }
  return state;
}

const EDGE_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_PORT',
  'PORT_TYPE_MISMATCH',
  'DANGLING_EDGE',
  'INPUT_MULTIPLE_EDGES',
  'OUTPUT_MULTIPLE_EDGES',
  'OUTPUT_MULTIPLE_WRITES',
  'SIZE_GATE_SHARED_OUTPUT',
]);

/** `intoBroken` is `edgesIntoBroken(graph, states)`: edges drawn broken because their target is. */
export function edgeStateFor(
  edgeId: string,
  issues: Issue[],
  intoBroken?: ReadonlySet<string>,
): EdgeState {
  const own = issues.filter((i) => i.edgeId === edgeId);
  const broken = (intoBroken?.has(edgeId) ?? false) || own.some((i) => EDGE_CODES.has(i.code));
  return { broken, issues: own };
}

/** Ids of the edges whose target node has a red border. */
export function edgesIntoBroken(
  g: WorkflowGraph,
  states: ReadonlyMap<string, NodeState>,
): Set<string> {
  return new Set(g.edges.filter((e) => states.get(e.to.node)?.border === 'red').map((e) => e.id));
}

/** Issues that belong to neither a node nor an edge. */
export function graphIssues(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.nodeId === undefined && i.edgeId === undefined);
}

export function firstError(issues: Issue[]): Issue | null {
  return issues.find((i) => i.severity === 'error') ?? null;
}

export function countIssues(issues: Issue[]): { errors: number; warnings: number } {
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { errors, warnings: issues.length - errors };
}
