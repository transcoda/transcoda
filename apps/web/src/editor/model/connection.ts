import type { NodeInfo } from '@transcoda/contract';
import {
  type FinishPhase,
  finishPhaseRank,
  type PortRef,
  type WorkflowGraph,
  type WorkflowKind,
} from '@transcoda/shared';
import type { Catalog, PortSpec, PortType } from '../../hooks/useCatalog.ts';

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

function portOf(
  g: WorkflowGraph,
  ref: PortRef,
  side: 'inputs' | 'outputs',
  catalog: Catalog,
): PortSpec | string {
  const node = g.nodes.find((n) => n.id === ref.node);
  if (!node) return 'That node no longer exists';
  const def = catalog.byType.get(node.type);
  if (!def) return `Unknown node type ${node.type}`;
  return def[side].find((p) => p.id === ref.port) ?? 'That port does not exist';
}

/** The editor's live connection rules; cycles are left to the server's `GRAPH_CYCLE`. */
export function checkConnection(
  g: WorkflowGraph,
  from: PortRef,
  to: PortRef,
  catalog: Catalog,
): ConnectionCheck {
  if (from.node === to.node) return { ok: false, reason: "A node can't connect to itself" };
  const out = portOf(g, from, 'outputs', catalog);
  if (typeof out === 'string') return { ok: false, reason: out };
  const input = portOf(g, to, 'inputs', catalog);
  if (typeof input === 'string') return { ok: false, reason: input };
  if (out.type !== input.type) {
    return { ok: false, reason: `Those ports don't match (${out.type} → ${input.type})` };
  }
  if (g.edges.some((e) => e.to.node === to.node && e.to.port === to.port)) {
    return { ok: false, reason: 'That input is already connected' };
  }
  return { ok: true };
}

/** What may follow an output in the "+" search (#25). */
export type NextRule =
  | { kind: 'any' }
  /**
   * After a finish node: finish nodes whose phase rank is >= `minRank` (a node with no declared
   * phase always fits); `noWrite` after the size gate's No (else) output: no 'gate' or 'write'
   * phase. `afterTitle`: the source node as the canvas names it, for the hint.
   */
  | { kind: 'finish-after'; minRank: number; noWrite: boolean; afterTitle: string };

/** Mirrors the server's SIZE_GATE_TYPE / SIZE_GATE_ELSE_PORT (apps/server/src/nodes/availability.ts). */
const SIZE_GATE_TYPE = 'core:size-gate';
const SIZE_GATE_ELSE_PORT = 'else';
/** The core write nodes (validate.ts WRITE_TYPES); both also declare the 'write' phase. */
const WRITE_TYPES: ReadonlySet<string> = new Set(['core:replace-original', 'core:move-copy']);
const WRITING_PHASES: ReadonlyArray<FinishPhase> = ['gate', 'write'];

/**
 * What may follow output `port` of node `nodeId`, mirroring validate.ts `checkPaths`
 * (FINISH_ORDER, ELSE_ONLY_NOTIFY): after a finish node only finish nodes of the same or a later
 * phase; after the size gate's Yes the write and later phases, after its No only the non-writing
 * phases; Render (the render phase) never comes after a finish node. A bypassed node runs no
 * hook, so it counts as not a finish node; a finish node with no declared phase allows finish
 * nodes of any other phase. Anything else: `{ kind: 'any' }`.
 */
export function nextNodeRule(
  g: WorkflowGraph,
  nodeId: string,
  port: string,
  catalog: Catalog,
): NextRule {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && catalog.byType.get(node.type);
  if (!node || !def || def.kind !== 'finish' || node.bypassed === true) return { kind: 'any' };
  const afterTitle = node.label ?? def.title;
  if (def.type === SIZE_GATE_TYPE) {
    const noWrite = port === SIZE_GATE_ELSE_PORT;
    const minRank = finishPhaseRank(noWrite ? 'library-manager' : 'write');
    return { kind: 'finish-after', minRank, noWrite, afterTitle };
  }
  const minRank = def.finishPhase ? finishPhaseRank(def.finishPhase) : 0;
  return { kind: 'finish-after', minRank, noWrite: false, afterTitle };
}

function fitsRule(n: NodeInfo, rule: NextRule): boolean {
  if (rule.kind === 'any') return true;
  if (n.kind !== 'finish') return false;
  const phase = n.finishPhase ?? null;
  // A path renders once, before its finish steps (RENDER_TWICE): Render never follows one.
  if (phase === 'render') return false;
  // After the size gate's No only a node that declares a non-writing phase may follow.
  if (
    rule.noWrite &&
    (phase === null ||
      n.type === SIZE_GATE_TYPE ||
      WRITE_TYPES.has(n.type) ||
      WRITING_PHASES.includes(phase))
  ) {
    return false;
  }
  return phase === null || finishPhaseRank(phase) >= rule.minRank;
}

/**
 * Catalogue nodes with an input of `portType`. A sub-workflow excludes trigger and finish nodes;
 * a main workflow excludes the sub-workflow start/end nodes. With a `rule` (`nextNodeRule`), only
 * the nodes that may follow there. Unavailable nodes stay in the list (the palette shows them
 * disabled with the reason).
 */
export function compatibleTargets(
  catalog: Catalog,
  portType: PortType,
  graphKind: WorkflowKind,
  rule: NextRule = { kind: 'any' },
): NodeInfo[] {
  const excluded: ReadonlyArray<NodeInfo['kind']> =
    graphKind === 'subworkflow' ? ['trigger', 'finish'] : ['subworkflow-io'];
  return catalog.nodes.filter(
    (n) =>
      !excluded.includes(n.kind) && n.inputs.some((p) => p.type === portType) && fitsRule(n, rule),
  );
}

/** Outputs of `nodeId` with no edge leaving them; empty for a missing or unknown node. */
export function freeOutputs(g: WorkflowGraph, nodeId: string, catalog: Catalog): PortSpec[] {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && catalog.byType.get(node.type);
  if (!def) return [];
  return def.outputs.filter(
    (p) => !g.edges.some((e) => e.from.node === nodeId && e.from.port === p.id),
  );
}
