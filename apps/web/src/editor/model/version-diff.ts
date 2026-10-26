import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { edgeKeys, graphEquals, isLayoutOnlyChange } from './equality.ts';

export type GraphChange =
  | { kind: 'added' | 'removed' | 'changed'; nodeId: string; title: string }
  | { kind: 'pin'; nodeId: string; title: string; from: number; to: number }
  | { kind: 'edges' };

export interface VersionDiff {
  layoutOnly: boolean;
  changes: GraphChange[];
}

/** One node's behaviour compared with the graph-level rule: type, typeVersion, settings, bypassed. */
function sameBehaviour(a: NodeInstance, b: NodeInstance): boolean {
  const alone = (n: NodeInstance, base: WorkflowGraph): WorkflowGraph => ({
    ...base,
    nodes: [n],
    edges: [],
    groups: [],
  });
  const base = { formatVersion: 1, kind: 'workflow' } as WorkflowGraph;
  return isLayoutOnlyChange(alone(a, base), alone(b, base));
}

const isObject = (v: JsonValue): v is { [key: string]: JsonValue } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The pinned version of a Run node's settings, when it has one. */
function pinOf(n: NodeInstance): number | null {
  const v = isObject(n.settings) ? n.settings.version : undefined;
  return typeof v === 'number' ? v : null;
}

function withoutPin(n: NodeInstance): NodeInstance {
  if (!isObject(n.settings)) return n;
  const { version: _version, ...rest } = n.settings;
  return { ...n, settings: rest };
}

/**
 * What differs between two versions of a graph, for the Activate dialog. A node counts as
 * `changed` when its type, typeVersion, settings or bypass flag differ (positions, labels and
 * groups never count); a Run node whose pinned version moved and nothing else is a `pin`.
 * Connections are reported once. `layoutOnly`: only positions, labels or groups differ.
 */
export function diffVersions(
  base: WorkflowGraph,
  next: WorkflowGraph,
  titleOf: (n: NodeInstance) => string,
): VersionDiff {
  const layoutOnly = isLayoutOnlyChange(base, next) && !graphEquals(base, next);
  const baseById = new Map(base.nodes.map((n) => [n.id, n]));
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));
  const added: GraphChange[] = [];
  const removed: GraphChange[] = [];
  const changed: GraphChange[] = [];
  const pins: GraphChange[] = [];
  for (const n of next.nodes) {
    if (!baseById.has(n.id)) added.push({ kind: 'added', nodeId: n.id, title: titleOf(n) });
  }
  for (const n of base.nodes) {
    const other = nextById.get(n.id);
    if (!other) {
      removed.push({ kind: 'removed', nodeId: n.id, title: titleOf(n) });
      continue;
    }
    if (sameBehaviour(n, other)) continue;
    const from = pinOf(n);
    const to = pinOf(other);
    if (from !== null && to !== null && sameBehaviour(withoutPin(n), withoutPin(other))) {
      pins.push({ kind: 'pin', nodeId: n.id, title: titleOf(other), from, to });
    } else changed.push({ kind: 'changed', nodeId: n.id, title: titleOf(other) });
  }
  const a = edgeKeys(base);
  const b = edgeKeys(next);
  const edges: GraphChange[] =
    a.length === b.length && a.every((k, i) => k === b[i]) ? [] : [{ kind: 'edges' }];
  return { layoutOnly, changes: [...added, ...removed, ...changed, ...pins, ...edges] };
}

function lineOf(c: GraphChange): string {
  switch (c.kind) {
    case 'added':
      return `Added ${c.title}`;
    case 'removed':
      return `Removed ${c.title}`;
    case 'changed':
      return `Changed ${c.title}`;
    case 'pin':
      return `${c.title} ${c.from}→${c.to}`;
    case 'edges':
      return 'Connections changed';
  }
}

/** The dialog's bullet lines: "Added Encode video", "Language cleanup 2→3", "Layout only". */
export function changeLines(d: VersionDiff): string[] {
  return d.layoutOnly ? ['Layout only'] : d.changes.map(lineOf);
}
