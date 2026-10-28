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

/** What the upgrade knows of a node type: its kind and its ports' types (`file`, `data:…`). */
export interface UpgradeNodeType {
  kind: string;
  inputs: readonly { id: string; type: string }[];
  outputs: readonly { id: string; type: string }[];
}

/**
 * Graph format 1 → 2, on raw JSON before schema parsing, so every reader keeps accepting format 1.
 * Format 2 renders in a visible `core:render` node: one is inserted on every file output of a
 * trigger, condition or action (or of a node `typeOf` does not know) whose edges all lead into
 * file inputs of finish nodes (`typeOf`);
 * the output's edges keep their ids and leave Render's Done instead, and Render takes the output
 * by a new edge `<render id>-in`. Data never goes through Render: a data node's or a data output's
 * edges stay as they are. An output that also feeds a node of another kind or another input, or of
 * a type `typeOf` does not know (a plugin that is not installed), gets no Render: validation
 * reports it. Render is laid out midway, at the source's height, in the source's group when the
 * targets share it. Sub-workflows hold no finish nodes and only change their version. Anything that
 * is not a format-1 graph object is returned as it is.
 */
export function upgradeGraphJson(
  raw: unknown,
  typeOf: (type: string) => UpgradeNodeType | undefined,
): unknown {
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

  const nodeType = (id: string | undefined): UpgradeNodeType | undefined => {
    const type = id === undefined ? undefined : str(byId.get(id)?.type);
    return type === undefined ? undefined : typeOf(type);
  };
  const portType = (ports: UpgradeNodeType['inputs'] | undefined, id: unknown) =>
    ports?.find((p) => p.id === id)?.type;
  // Render's incoming edge goes just before the first edge it takes over.
  const inserted = new Map<number, Obj>();
  let n = 1;
  for (const { from, indexes } of groups.values()) {
    const sourceId = str(from.node) as string;
    const source = byId.get(sourceId);
    // A source of a type not installed is taken by its targets' inputs: a file input takes a file.
    const sourceType = nodeType(sourceId);
    if (!source) continue;
    if (sourceType && !['trigger', 'condition', 'action'].includes(sourceType.kind)) continue;
    if (sourceType && portType(sourceType.outputs, from.port) !== 'file') continue;
    const ends = indexes.map((i) => {
      const to = (edges[i] as Obj).to;
      return isObj(to) ? { node: byId.get(str(to.node) ?? ''), port: to.port } : undefined;
    });
    const intoFinishFile = (end: (typeof ends)[number]) => {
      const t = nodeType(str(end?.node?.id));
      return (
        t?.kind === 'finish' &&
        str(end?.node?.type) !== RENDER_TYPE &&
        portType(t.inputs, end?.port) === 'file'
      );
    };
    if (!ends.every(intoFinishFile)) continue;
    const targets = ends.map((end) => end?.node);

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
