import {
  type Group,
  type NodeInstance,
  SUBWORKFLOW_START_TYPE,
  type WorkflowGraph,
} from '@transcoda/shared';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { GROUP_PADDING, NODE_SIZE, type OpResult, type Position, type Size } from './graph-ops.ts';

/**
 * "Tidy up": a small layered layout. Columns follow the graph's order (a node sits one column
 * after its longest path in, so the trigger comes first and finishes last); rows follow branches
 * (a node continues its first parent's row, a condition's "Yes" output before its "No", and
 * every further branch opens a row below). A group is laid out inside, then placed as one block.
 */

/** Room between columns (the TV cleanup example's step minus a card) and between rows. */
const GAP_X = 90;
const GAP_Y = 80;

export interface TidyOptions {
  /** Port order of conditions ("Yes" before "No") and the trigger; without it, edge order. */
  catalog?: Catalog | null;
  /** Measured card sizes (cards grow with their port rows); never less than `NODE_SIZE`. */
  sizes?: ReadonlyMap<string, Size>;
  /** The tile a collapsed group is drawn as; its stored size otherwise. */
  collapsedGroupSize?: Size;
}

/** A box to place: a card, or a group with its members already arranged inside. */
interface Item {
  id: string;
  width: number;
  height: number;
  /** How far the first row of cards sits below the box's top (a group's padding). */
  anchor: number;
  /** The trigger or a sub-workflow's start: the first row starts with it. */
  lead: boolean;
  /** Where it is now, to keep the order of otherwise equal items. */
  at: Position;
}

/** `rank` orders a source's links: its member's row, then the output port, then the edge. */
interface Link {
  from: string;
  to: string;
  rank: number[];
}

const byRank = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
const byPlace = (a: Item, b: Item) => a.at.y - b.at.y || a.at.x - b.at.x || (a.id < b.id ? -1 : 1);

/** Top-left of each item's box; the boxes together start at (0, 0). */
function arrange(items: Item[], links: Link[]): Map<string, Position> {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const sorted = [...items].sort((a, b) => Number(b.lead) - Number(a.lead) || byPlace(a, b));
  const out = new Map<string, Link[]>(items.map((i) => [i.id, []]));
  const incoming = new Set<string>();
  for (const l of links) {
    if (l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) continue;
    out.get(l.from)?.push(l);
    incoming.add(l.to);
  }
  for (const list of out.values()) {
    list.sort(
      (a, b) => byRank(a.rank, b.rank) || byPlace(byId.get(a.to) as Item, byId.get(b.to) as Item),
    );
  }

  // Depth-first from the roots: a link back to an item still on the path closes a cycle and is
  // left out of the layering (the server refuses cycles, but a draft may have one).
  const forward = new Map<string, string[]>(items.map((i) => [i.id, []]));
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const l of out.get(id) ?? []) {
      const s = state.get(l.to);
      if (s === 'open') continue;
      const next = forward.get(id) as string[];
      if (!next.includes(l.to)) next.push(l.to);
      if (s === undefined) visit(l.to);
    }
    state.set(id, 'done');
  };
  const roots = sorted.filter((i) => !incoming.has(i.id));
  for (const i of [...roots, ...sorted]) if (!state.has(i.id)) visit(i.id);

  // Columns: one after the longest forward path in.
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>(items.map((i) => [i.id, 0]));
  for (const next of forward.values()) {
    for (const t of next) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  const queue = sorted.filter((i) => indegree.get(i.id) === 0).map((i) => i.id);
  for (const id of queue) layer.set(id, 0);
  for (let k = 0; k < queue.length; k++) {
    const id = queue[k] as string;
    for (const t of forward.get(id) ?? []) {
      layer.set(t, Math.max(layer.get(t) ?? 0, (layer.get(id) ?? 0) + 1));
      const left = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, left);
      if (left === 0) queue.push(t);
    }
  }

  // Rows: a chain of first children shares its parent's row; further branches open new rows,
  // after the rows of the branches before them. Each chain's columns rise, so no two items meet.
  const row = new Map<string, number>();
  let rows = 0;
  const place = (id: string, r: number) => {
    row.set(id, r);
    let first = true;
    for (const t of forward.get(id) ?? []) {
      if (row.has(t)) continue;
      place(t, first ? r : rows++);
      first = false;
    }
  };
  const fed = new Set([...forward.values()].flat());
  for (const i of [...sorted.filter((s) => !fed.has(s.id)), ...sorted]) {
    if (!row.has(i.id)) place(i.id, rows++);
  }

  const columns = Math.max(0, ...layer.values()) + 1;
  const colWidth = new Array<number>(columns).fill(0);
  const rowAbove = new Array<number>(rows).fill(0);
  const rowBelow = new Array<number>(rows).fill(0);
  for (const i of items) {
    const c = layer.get(i.id) ?? 0;
    const r = row.get(i.id) ?? 0;
    colWidth[c] = Math.max(colWidth[c] ?? 0, i.width);
    rowAbove[r] = Math.max(rowAbove[r] ?? 0, i.anchor);
    rowBelow[r] = Math.max(rowBelow[r] ?? 0, i.height - i.anchor);
  }
  const colX: number[] = [];
  for (let c = 0, x = 0; c < columns; c++) {
    colX.push(x);
    x += (colWidth[c] ?? 0) + GAP_X;
  }
  // The y of each row's first card (boxes with an anchor reach above it).
  const rowY: number[] = [];
  for (let r = 0, y = 0; r < rows; r++) {
    y += rowAbove[r] ?? 0;
    rowY.push(y);
    y += (rowBelow[r] ?? 0) + GAP_Y;
  }

  const result = new Map<string, Position>();
  for (const i of items) {
    result.set(i.id, {
      x: colX[layer.get(i.id) ?? 0] ?? 0,
      y: (rowY[row.get(i.id) ?? 0] ?? 0) - i.anchor,
    });
  }
  return result;
}

/** Rearranges every node (and group) of `g`; only positions and group boxes change. */
export function tidyUp(g: WorkflowGraph, opts: TidyOptions = {}): OpResult {
  if (g.nodes.length === 0) return { ok: true, graph: g };
  const { catalog = null, sizes = new Map<string, Size>() } = opts;
  const groups = new Map(g.groups.map((gr) => [gr.id, gr] as const));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n] as const));
  const unitOf = (n: NodeInstance) =>
    n.groupId !== undefined && groups.has(n.groupId) ? n.groupId : n.id;
  // Zoomed out, cards are drawn (and measured) as small tiles: never space by less than a card.
  const sizeOf = (id: string): Size => {
    const m = sizes.get(id);
    return {
      width: Math.max(m?.width ?? 0, NODE_SIZE.width),
      height: Math.max(m?.height ?? 0, NODE_SIZE.height),
    };
  };
  const isLead = (n: NodeInstance) =>
    n.type === SUBWORKFLOW_START_TYPE || catalog?.byType.get(n.type)?.kind === 'trigger';
  const portIndex = (n: NodeInstance, port: string) => {
    const i = catalog?.byType.get(n.type)?.outputs.findIndex((p) => p.id === port) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const cardItem = (n: NodeInstance): Item => ({
    id: n.id,
    ...sizeOf(n.id),
    anchor: 0,
    lead: isLead(n),
    at: n.position,
  });

  // Each group's members, arranged among themselves (their links inside the group only).
  const inner = new Map<string, Map<string, Position>>();
  const groupItems: Item[] = [];
  const groupSize = new Map<string, Size>();
  for (const gr of g.groups) {
    const members = g.nodes.filter((n) => n.groupId === gr.id);
    const links: Link[] = g.edges.flatMap((e, k) => {
      const from = nodeById.get(e.from.node);
      const to = nodeById.get(e.to.node);
      if (from?.groupId !== gr.id || to?.groupId !== gr.id) return [];
      return [{ from: from.id, to: to.id, rank: [portIndex(from, e.from.port), k] }];
    });
    const placed = arrange(members.map(cardItem), links);
    inner.set(gr.id, placed);
    const width = Math.max(
      0,
      ...members.map((m) => (placed.get(m.id)?.x ?? 0) + sizeOf(m.id).width),
    );
    const height = Math.max(
      0,
      ...members.map((m) => (placed.get(m.id)?.y ?? 0) + sizeOf(m.id).height),
    );
    const size =
      members.length > 0
        ? { width: width + 2 * GROUP_PADDING, height: height + 2 * GROUP_PADDING }
        : gr.size;
    groupSize.set(gr.id, size);
    const shown = gr.collapsed ? (opts.collapsedGroupSize ?? size) : size;
    groupItems.push({
      id: gr.id,
      ...shown,
      anchor: gr.collapsed || members.length === 0 ? 0 : GROUP_PADDING,
      lead: members.some(isLead),
      at: gr.position,
    });
  }

  // The top level: ungrouped cards and whole groups; a link leaves a group from its member's row.
  const items = [...g.nodes.filter((n) => unitOf(n) === n.id).map(cardItem), ...groupItems];
  const links: Link[] = g.edges.flatMap((e, k) => {
    const from = nodeById.get(e.from.node);
    const to = nodeById.get(e.to.node);
    if (!from || !to) return [];
    const fromUnit = unitOf(from);
    const memberY = fromUnit === from.id ? 0 : (inner.get(fromUnit)?.get(from.id)?.y ?? 0);
    return [{ from: fromUnit, to: unitOf(to), rank: [memberY, portIndex(from, e.from.port), k] }];
  });
  const placed = arrange(items, links);

  // Keep the layout where the graph was: its top-left corner stays.
  const left = Math.min(
    ...g.nodes.map((n) => n.position.x),
    ...g.groups.map((gr) => gr.position.x),
  );
  const top = Math.min(...g.nodes.map((n) => n.position.y), ...g.groups.map((gr) => gr.position.y));
  const at = (p: Position | undefined, dx = 0, dy = 0): Position => ({
    x: Math.round(left + (p?.x ?? 0) + dx),
    y: Math.round(top + (p?.y ?? 0) + dy),
  });

  const nextGroups: Group[] = g.groups.map((gr) => ({
    ...gr,
    position: at(placed.get(gr.id)),
    size: groupSize.get(gr.id) ?? gr.size,
  }));
  const groupAt = new Map(nextGroups.map((gr) => [gr.id, gr.position] as const));
  const nodes = g.nodes.map((n) => {
    const unit = unitOf(n);
    if (unit === n.id) return { ...n, position: at(placed.get(n.id)) };
    const box = groupAt.get(unit) ?? { x: 0, y: 0 };
    const rel = inner.get(unit)?.get(n.id) ?? { x: 0, y: 0 };
    return {
      ...n,
      position: {
        x: box.x + GROUP_PADDING + rel.x,
        y: box.y + GROUP_PADDING + rel.y,
      },
    };
  });
  return { ok: true, graph: { ...g, nodes, groups: nextGroups } };
}
