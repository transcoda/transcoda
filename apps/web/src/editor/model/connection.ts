import type { NodeInfo } from '@transcoda/contract';
import {
  CHECK_SOURCE_DAMAGED_PORT,
  CHECK_SOURCE_TYPE,
  type FinishPhase,
  finishPhaseRank,
  type PortRef,
  portShown,
  RENDER_DAMAGED_PORT,
  RENDER_TYPE,
  type WorkflowGraph,
  type WorkflowKind,
} from '@transcoda/shared';
import type { Catalog, PortSpec, PortType } from '../../hooks/useCatalog.ts';
import { shownOutputs } from './hidden-ports.ts';

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

/** A Damaged output: Render's (while Quality check is on) or Check source's. */
export function isDamagedOutput(type: string, port: string): boolean {
  return (
    (type === RENDER_TYPE && port === RENDER_DAMAGED_PORT) ||
    (type === CHECK_SOURCE_TYPE && port === CHECK_SOURCE_DAMAGED_PORT)
  );
}

/**
 * Whether output `port` of `nodeId` is on a Damaged side: a Damaged output itself, or an output of
 * a finish node whose file comes (through finish nodes only) from a Damaged output. A node whose
 * file input has several connections is on a Damaged side only when every one of them is: the
 * file may come by any of them. Mirrors validate.ts `afterDamaged` / `afterSourceDamaged`, which
 * checks each path on its own.
 */
export function onDamagedSide(
  g: WorkflowGraph,
  nodeId: string,
  port: string,
  catalog: Catalog,
): boolean {
  /** `${node}\0${port}` → the answer; false while being worked out (a cycle is not a Damaged side). */
  const known = new Map<string, boolean>();
  const side = (at: string, leaving: string): boolean => {
    const key = `${at}\0${leaving}`;
    const hit = known.get(key);
    if (hit !== undefined) return hit;
    known.set(key, false);
    const node = g.nodes.find((n) => n.id === at);
    let result = false;
    if (node && isDamagedOutput(node.type, leaving)) result = true;
    else if (node && catalog.byType.get(node.type)?.kind === 'finish') {
      const into = g.edges.filter(
        (e) => e.to.node === at && catalog.portType(node.type, e.to.port) === 'file',
      );
      result = into.length > 0 && into.every((e) => side(e.from.node, e.from.port));
    }
    known.set(key, result);
    return result;
  };
  return side(nodeId, port);
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
  const source = g.nodes.find((n) => n.id === from.node);
  if (source && out.shownWhen !== undefined && !portShown(out, source.settings)) {
    return { ok: false, reason: hiddenOutputReason(out, catalog.byType.get(source.type)) };
  }
  if (out.type !== input.type) {
    return { ok: false, reason: `Those ports don't match (${out.type} → ${input.type})` };
  }
  // A file input takes any number of connections (branches that never both run merge there); a
  // data input takes one (validate.ts INPUT_MULTIPLE_EDGES).
  if (
    input.type !== 'file' &&
    g.edges.some((e) => e.to.node === to.node && e.to.port === to.port)
  ) {
    return { ok: false, reason: 'That data input is already connected' };
  }
  const target = g.nodes.find((n) => n.id === to.node);
  const targetDef = target && catalog.byType.get(target.type);
  if (targetDef?.damagedOnly === true && !onDamagedSide(g, from.node, from.port, catalog)) {
    return {
      ok: false,
      reason: `${target?.label ?? targetDef.title} can only follow a Damaged output`,
    };
  }
  return { ok: true };
}

/** "That output is only there while Quality check is on" (the setting as the inspector names it). */
function hiddenOutputReason(out: PortSpec, def: NodeInfo | undefined): string {
  const setting = out.shownWhen?.setting ?? '';
  const schema = def?.settingsSchema as
    | { properties?: Record<string, { description?: unknown }> }
    | undefined;
  const described = schema?.properties?.[setting]?.description;
  const name = typeof described === 'string' ? described : setting;
  return out.shownWhen?.equals === true
    ? `That output is only there while ${name} is on`
    : `That output is only there for another ${name}`;
}

/** What may follow an output in the "+" search (#25). */
export type NextRule =
  | { kind: 'any' }
  /**
   * After a finish node: finish nodes whose phase rank is >= `minRank` (a node with no declared
   * phase always fits); `noWrite` after the size gate's No (else) output: no 'gate' or 'write'
   * phase. `afterTitle`: the source node as the canvas names it, for the hint. `damaged`: on a
   * Damaged side (only non-writing steps, and `damagedOnly` nodes fit there only).
   */
  | {
      kind: 'finish-after';
      minRank: number;
      noWrite: boolean;
      afterTitle: string;
      damaged?: boolean;
    };

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
 * nodes of any other phase. After a Damaged output (Render's or Check source's) and the finish
 * steps on that side: only non-writing phases, `damagedOnly` nodes included. Anything else:
 * `{ kind: 'any' }`.
 */
export function nextNodeRule(
  g: WorkflowGraph,
  nodeId: string,
  port: string,
  catalog: Catalog,
): NextRule {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && catalog.byType.get(node.type);
  if (!node || !def) return { kind: 'any' };
  const afterTitle = node.label ?? def.title;
  // After a Damaged output (and the steps on that side) only non-writing finish steps follow.
  if (node.bypassed !== true && onDamagedSide(g, nodeId, port, catalog)) {
    const own = def.kind === 'finish' && def.finishPhase ? finishPhaseRank(def.finishPhase) : 0;
    const minRank = Math.max(finishPhaseRank('library-manager'), own);
    return { kind: 'finish-after', minRank, noWrite: true, afterTitle, damaged: true };
  }
  if (def.kind !== 'finish' || node.bypassed === true) return { kind: 'any' };
  if (def.type === RENDER_TYPE) {
    return { kind: 'finish-after', minRank: finishPhaseRank('gate'), noWrite: false, afterTitle };
  }
  if (def.type === SIZE_GATE_TYPE) {
    const noWrite = port === SIZE_GATE_ELSE_PORT;
    const minRank = finishPhaseRank(noWrite ? 'library-manager' : 'write');
    return { kind: 'finish-after', minRank, noWrite, afterTitle };
  }
  const minRank = def.finishPhase ? finishPhaseRank(def.finishPhase) : 0;
  return { kind: 'finish-after', minRank, noWrite: false, afterTitle };
}

function fitsRule(n: NodeInfo, rule: NextRule): boolean {
  // A `damagedOnly` node (a plugin's "Replace damaged file") belongs on a Damaged side only.
  if (n.damagedOnly === true && (rule.kind === 'any' || rule.damaged !== true)) return false;
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
  if (!def || !node) return [];
  return shownOutputs(def, node).filter(
    (p) => !g.edges.some((e) => e.from.node === nodeId && e.from.port === p.id),
  );
}
