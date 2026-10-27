import { RENDER_DONE_PORT, RENDER_TYPE } from './render.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function coord(node: Obj | undefined, axis: 'x' | 'y'): number {
  const p = node?.position;
  const v = isObj(p) ? p[axis] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Graph format 1 → 2, on raw JSON before schema parsing, so every reader keeps accepting format 1.
 * Format 2 renders in a visible `core:render` node: one is inserted on every output whose edges all
 * lead from a non-finish node (trigger, condition, action) into finish nodes (`isFinish`); the
 * output's edges keep their ids and leave Render's Done instead, and Render takes the output by a
 * new edge `<render id>-in`. An output that also feeds a node of another kind, or of a type
 * `isFinish` does not know (a plugin that is not installed), gets no Render: validation reports
 * it. Render is laid out midway, at the source's height, in the source's group when the targets
 * share it. Sub-workflows hold no finish nodes and only change their version. Anything that is not
 * a format-1 graph object is returned as it is.
 */
export function upgradeGraphJson(raw: unknown, isFinish: (type: string) => boolean): unknown {
  if (!isObj(raw) || raw.formatVersion !== 1) return raw;
  const out: Obj = { ...raw, formatVersion: 2 };
  if (raw.kind !== 'workflow' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return out;
  }
  const nodes: unknown[] = [...raw.nodes];
  const edges: unknown[] = [...raw.edges];
  const byId = new Map<string, Obj>();
  for (const n of nodes) {
    const id = isObj(n) ? str(n.id) : undefined;
    if (id !== undefined && isObj(n)) byId.set(id, n);
  }
  const edgeIds = new Set(edges.flatMap((e) => (isObj(e) && str(e.id) ? [str(e.id)] : [])));

  // Edge indexes by source output, in the order the outputs first appear.
  const groups = new Map<string, { from: Obj; indexes: number[] }>();
  edges.forEach((e, i) => {
    if (!isObj(e) || !isObj(e.from)) return;
    const node = str(e.from.node);
    const port = str(e.from.port);
    if (node === undefined || port === undefined) return;
    const key = `${node}\u0000${port}`;
    const group = groups.get(key) ?? { from: e.from, indexes: [] };
    group.indexes.push(i);
    groups.set(key, group);
  });

  const finishType = (id: string | undefined): string | null => {
    const type = id === undefined ? undefined : str(byId.get(id)?.type);
    return type !== undefined && isFinish(type) ? type : null;
  };
  // Render's incoming edge goes just before the first edge it takes over.
  const inserted = new Map<number, Obj>();
  let n = 1;
  for (const { from, indexes } of groups.values()) {
    const sourceId = str(from.node) as string;
    const source = byId.get(sourceId);
    if (!source || finishType(sourceId) !== null) continue;
    const targets = indexes.map((i) => {
      const to = (edges[i] as Obj).to;
      return isObj(to) ? byId.get(str(to.node) ?? '') : undefined;
    });
    const types = targets.map((t) => finishType(str(t?.id)));
    if (types.some((t) => t === null || t === RENDER_TYPE)) continue;

    while (byId.has(`render-${n}`) || edgeIds.has(`render-${n}-in`)) n++;
    const id = `render-${n}`;
    const minTargetX = Math.min(...targets.map((t) => coord(t, 'x')));
    const groupId = str(source.groupId);
    const render: Obj = {
      id,
      type: RENDER_TYPE,
      typeVersion: 1,
      settings: {},
      position: {
        x: Math.round((coord(source, 'x') + minTargetX) / 2),
        y: coord(source, 'y'),
      },
      ...(groupId !== undefined && targets.every((t) => str(t?.groupId) === groupId)
        ? { groupId }
        : {}),
    };
    nodes.push(render);
    byId.set(id, render);
    edgeIds.add(`${id}-in`);
    for (const i of indexes) {
      const e = edges[i] as Obj;
      edges[i] = { ...e, from: { node: id, port: RENDER_DONE_PORT } };
    }
    inserted.set(indexes[0] as number, {
      id: `${id}-in`,
      from: { node: sourceId, port: str(from.port) },
      to: { node: id, port: 'file' },
    });
  }
  out.nodes = nodes;
  out.edges = edges.flatMap((e, i) => {
    const before = inserted.get(i);
    return before ? [before, e] : [e];
  });
  return out;
}
