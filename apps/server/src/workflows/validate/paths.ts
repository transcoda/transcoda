import type { AnyNodeDefinition } from '@transcoda/sdk';
import {
  ALREADY_PROCESSED_TYPE,
  CHECK_SOURCE_DAMAGED_PORT,
  CHECK_SOURCE_TYPE,
  type Edge,
  finishPhaseRank,
  type Issue,
  type NodeInstance,
  portShown,
  RENDER_DAMAGED_PORT,
  RENDER_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import { SIZE_GATE_ELSE_PORT, SIZE_GATE_TYPE } from '../../nodes/availability.ts';
import { defOf, error, title, warning } from './issues.ts';
import { checkEdges, checkNodes } from './nodes.ts';
import { WRITE_TYPES } from './outputs.ts';
import type { NodeState, ValidationContext } from './types.ts';

// The path rules: what may follow what along each path a file can take from the trigger.

/** Already processed's Yes (`pass`): the file has been through the workflow before. */
const PROCESSED_PORT = 'pass';

const ELSE_ONLY_NOTIFY_TEXT =
  'After the size gate\u2019s \u201cNo\u201d, only notifications and other non-writing finish steps can follow.';

const DAMAGED_ONLY_NOTIFY_TEXT =
  'After Render\u2019s Damaged, only notifications and other non-writing finish steps can follow.';

const SOURCE_DAMAGED_ONLY_NOTIFY_TEXT =
  'After Check source\u2019s Damaged, only notifications and other non-writing finish steps can follow.';

/** A finish step that renders, gates or writes: none may run where no result is written. */
function writesOrGates(def: AnyNodeDefinition): boolean {
  return (
    def.kind === 'finish' &&
    (WRITE_TYPES.has(def.type) ||
      def.type === SIZE_GATE_TYPE ||
      def.type === RENDER_TYPE ||
      def.finishPhase === 'write' ||
      def.finishPhase === 'gate' ||
      def.finishPhase === 'render')
  );
}

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
 * The path rules: every path from the trigger, walked per file output port (hidden ports left
 * out) with its flags: a write node was passed, a finish node was passed, a Render was passed, the
 * path is below a size gate's `else` or below Render's Damaged. Iterative DFS memoised on
 * `(node, flags)`, so each node is expanded a bounded number of times whatever the number of paths.
 * Bypassed nodes run no hook (the engine passes the file through on their first file output), so
 * they neither set the flags nor break the order; a bypassed Render is an error of its own.
 * - FINISH_ORDER: an action after a finish node, or a finish phase after a later one;
 * - ELSE_ONLY_NOTIFY / DAMAGED_ONLY_NOTIFY: a step that renders, gates or writes below `else` or
 *   Damaged;
 * - RENDER_MISSING (on the finish node), RENDER_TWICE, RENDER_BYPASSED: exactly one running Render
 *   before the finish steps of every path;
 * - DAMAGED_ONLY: a `damagedOnly` finish node on a path that is not below a Damaged output;
 * - NO_WRITE_PATH (warning): a path that ends without a write, on the node where it ends (no file
 *   output connected), except below `else`, Damaged or Already processed's Yes. A node with one
 *   output connected and another open is not warned: the open one is a deliberate "nothing to
 *   do" end.
 * Returns the number of expansions.
 */
export function checkPaths(
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
  type Visit = {
    id: string;
    wrote: boolean;
    finished: boolean;
    /** The highest finish phase passed so far (-1: none); `by` names the node that set it. */
    rank: number;
    by: string;
    /** A Render was passed (a bypassed one too: it is reported on its own). */
    rendered: boolean;
    /** Below a size gate's `else`: nothing may write there, and nothing needs to. */
    afterElse: boolean;
    /** Below Render's Damaged: as below `else`; `damagedOnly` nodes belong here only. */
    afterDamaged: boolean;
    /** Below Check source's Damaged: as below Render's, and no Render is needed (or allowed). */
    afterSourceDamaged: boolean;
    /** Below Already processed's Yes: a branch for files done before, which needs no write. */
    afterProcessed: boolean;
  };
  const flag = (b: boolean) => (b ? 1 : 0);
  const stack: Visit[] = [
    {
      id: root.id,
      wrote: false,
      finished: false,
      rank: -1,
      by: '',
      rendered: false,
      afterElse: false,
      afterDamaged: false,
      afterSourceDamaged: false,
      afterProcessed: false,
    },
  ];
  let visits = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { id } = top;
    const key = `${id}:${flag(top.wrote)}${flag(top.finished)}${flag(top.rendered)}${flag(top.afterElse)}${flag(top.afterDamaged)}${flag(top.afterSourceDamaged)}${flag(top.afterProcessed)}:${top.rank}`;
    const n = byId.get(id);
    if (!n || expanded.has(key)) continue;
    expanded.add(key);
    visits++;
    const def = defOf(states.get(id));
    const name = title(n, def);
    let { wrote, finished, rank, by, rendered } = top;
    const { afterElse, afterDamaged, afterSourceDamaged, afterProcessed } = top;
    const isRender = def?.type === RENDER_TYPE;
    if (isRender && n.bypassed === true) {
      report(
        `render-bypassed:${id}`,
        error('RENDER_BYPASSED', 'Render can\u2019t be skipped: the file is rendered here', {
          nodeId: id,
        }),
      );
      rendered = true;
    }
    if (def && n.bypassed !== true) {
      if (afterSourceDamaged && (def.kind !== 'finish' || writesOrGates(def))) {
        report(
          `source-damaged-only-notify:${id}`,
          error('DAMAGED_ONLY_NOTIFY', SOURCE_DAMAGED_ONLY_NOTIFY_TEXT, { nodeId: id }),
        );
      } else if (afterDamaged && writesOrGates(def)) {
        report(
          `damaged-only-notify:${id}`,
          error('DAMAGED_ONLY_NOTIFY', DAMAGED_ONLY_NOTIFY_TEXT, { nodeId: id }),
        );
      } else if (afterElse && writesOrGates(def)) {
        report(
          `else-only-notify:${id}`,
          error('ELSE_ONLY_NOTIFY', ELSE_ONLY_NOTIFY_TEXT, { nodeId: id }),
        );
      } else if (isRender && rendered) {
        report(
          `render-twice:${id}`,
          error('RENDER_TWICE', `${name} comes after another Render; a path renders once`, {
            nodeId: id,
          }),
        );
      }
      if (def.kind === 'finish' && !isRender && !rendered && !afterDamaged) {
        report(
          `render-missing:${id}`,
          error(
            'RENDER_MISSING',
            `Put a Render step before ${name}: every path that reaches a finish step renders once`,
            { nodeId: id },
          ),
        );
      }
      if (def.kind === 'finish' && def.damagedOnly === true && !afterDamaged) {
        report(
          `damaged-only:${id}`,
          error('DAMAGED_ONLY', `${name} can only follow a Damaged output`, { nodeId: id }),
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
      if (isRender) rendered = true;
    }
    const fileOutputs = def
      ? def.outputs.filter((p) => p.type === 'file' && portShown(p, n.settings)).map((p) => p.id)
      : (fromPorts.get(id) ?? []);
    const ports = n.bypassed === true ? fileOutputs.slice(0, 1) : fileOutputs;
    const connected = ports.filter((p) => (next.get(`${id}:${p}`)?.length ?? 0) > 0);
    const isGate = def?.type === SIZE_GATE_TYPE && n.bypassed !== true;
    const runsRender = isRender && n.bypassed !== true;
    const checksSource = def?.type === CHECK_SOURCE_TYPE && n.bypassed !== true;
    const checksProcessed = def?.type === ALREADY_PROCESSED_TYPE && n.bypassed !== true;
    // Only a node with no file output connected ends the path here. An open output beside a
    // connected one ends "nothing to do" on purpose (Check source's OK after Already processed's
    // Yes: the file is fine, nothing to write); an open `else` or Damaged keeps the original.
    if (connected.length === 0 && !wrote && !afterElse && !afterDamaged && !afterProcessed) {
      report(
        `write:${id}`,
        warning('NO_WRITE_PATH', 'this path never writes the result', { nodeId: id }),
      );
    }
    for (const port of [...connected].reverse()) {
      const targets = next.get(`${id}:${port}`) ?? [];
      const branchElse = afterElse || (isGate && port === SIZE_GATE_ELSE_PORT);
      const branchSource =
        afterSourceDamaged || (checksSource && port === CHECK_SOURCE_DAMAGED_PORT);
      const branchDamaged =
        afterDamaged || branchSource || (runsRender && port === RENDER_DAMAGED_PORT);
      const branchProcessed = afterProcessed || (checksProcessed && port === PROCESSED_PORT);
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
          rendered,
          afterElse: branchElse,
          afterDamaged: branchDamaged,
          afterSourceDamaged: branchSource,
          afterProcessed: branchProcessed,
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
