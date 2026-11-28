// Where the editor page puts a new card: from the palette (a click or a drop) or from the node
// search, in the part of the canvas that is in view.
import type { NodeInfo, WorkflowSummary } from '@transcoda/contract';
import { RUN_SUBWORKFLOW_TYPE, SUBWORKFLOW_END_TYPE, shortId } from '@transcoda/shared';
import { useReactFlow } from '@xyflow/react';
import { type Dispatch, type RefObject, useCallback } from 'react';
import type { Catalog, PortSpec } from '../hooks/use-catalog.ts';
import type { EditorAction } from './model/editor-state.ts';
import {
  addNode,
  connect,
  NODE_SIZE,
  type Position,
  type Size,
  setSettings,
} from './model/graph-ops.ts';
import { addNote, addValuesCard } from './model/notes-values.ts';
import { freeSpot, type ViewRect } from './model/placement.ts';
import type { GraphOp } from './ui/Canvas.tsx';
import type { PaletteItem } from './ui/Palette.tsx';
import type { EditorLatest } from './use-editor-save.ts';

/** Horizontal step between a node and the one added after it. */
const NEXT_STEP_X = NODE_SIZE.width + 70;

/** The key, zoom controls and minimap sit along the canvas bottom (44 px controls + 16 px margin + gap). */
const BOTTOM_OVERLAYS = 72;

export function chain(steps: GraphOp[]): GraphOp {
  return (g) => {
    let graph = g;
    for (const step of steps) {
      const r = step(graph);
      if (!r.ok) return r;
      graph = r.graph;
    }
    return { ok: true, graph };
  };
}

/** What a palette item adds, selected once it is on the canvas (the values card is not). */
type AddedSelection = { nodes: string[]; edges: string[]; group?: string } | null;

/** The graph op that adds a palette item at `pos`, and the selection that shows the new item. */
function addItem(
  item: PaletteItem,
  pos: Position,
  catalog: Catalog,
  view: ViewRect | undefined,
): { op: GraphOp; select: AddedSelection } {
  const id = shortId();
  const node = (nodeId: string): AddedSelection => ({ nodes: [nodeId], edges: [] });
  if (item.kind === 'node')
    return {
      op: (g) => addNode(g, item.def.type, freeSpot(g, pos, view), catalog, { id }),
      select: node(id),
    };
  if (item.kind === 'end')
    return {
      op: (g) => addNode(g, SUBWORKFLOW_END_TYPE, freeSpot(g, pos, view), catalog, { id }),
      select: node(id),
    };
  if (item.kind === 'note')
    return { op: (g) => addNote(g, pos, id), select: { nodes: [], edges: [], group: id } };
  if (item.kind === 'values') return { op: (g) => addValuesCard(g, pos), select: null };
  const { workflow } = item;
  return {
    op: chain([
      (g) => addNode(g, RUN_SUBWORKFLOW_TYPE, freeSpot(g, pos, view), catalog, { id }),
      (g) =>
        setSettings(g, id, {
          subworkflowId: workflow.id,
          version: workflow.currentVersion,
          overrides: {},
        }),
    ]),
    select: node(id),
  };
}

export type SearchState = { from: { nodeId: string; port: PortSpec } | null };

export function usePaletteAdd({
  canvasRef,
  latest,
  apply,
  dispatch,
  search,
  setSearch,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  latest: RefObject<EditorLatest>;
  apply(op: GraphOp): boolean;
  dispatch: Dispatch<EditorAction>;
  /** The node search, open with what the new node connects from. */
  search: SearchState | null;
  setSearch(search: SearchState | null): void;
}) {
  const rf = useReactFlow();

  /**
   * The canvas area cards can be seen in, on screen: the canvas less the banners on top and the
   * key, zoom controls and minimap row at the bottom. Null before layout.
   */
  const clearBox = useCallback((): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null => {
    const wrap = canvasRef.current;
    const box = wrap?.getBoundingClientRect();
    if (!wrap || !box || box.width === 0 || box.height === 0) return null;
    const banners = wrap.querySelector('.canvas-banners');
    const bannerBottom =
      banners && banners.childElementCount > 0
        ? banners.getBoundingClientRect().bottom + 8
        : box.top;
    const top = Math.min(Math.max(box.top, bannerBottom), box.bottom);
    const bottom = Math.max(top, box.bottom - BOTTOM_OVERLAYS);
    return { left: box.left, top, right: box.right, bottom };
  }, [canvasRef]);

  /** The visible part of the canvas in flow coordinates; undefined before layout. */
  const viewRect = useCallback((): ViewRect | undefined => {
    const box = clearBox();
    if (!box) return undefined;
    const a = rf.screenToFlowPosition({ x: box.left, y: box.top });
    const b = rf.screenToFlowPosition({ x: box.right, y: box.bottom });
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  }, [rf, clearBox]);

  /** The flow position of the canvas centre, less half a card so the card is centred. */
  const centre = useCallback((): Position => {
    const box = clearBox();
    const p = rf.screenToFlowPosition({
      x: box ? (box.left + box.right) / 2 : 0,
      y: box ? (box.top + box.bottom) / 2 : 0,
    });
    return {
      x: Math.round(p.x - NODE_SIZE.width / 2),
      y: Math.round(p.y - NODE_SIZE.height / 2),
    };
  }, [rf, clearBox]);

  const addFromPalette = useCallback(
    (item: PaletteItem, pos: Position) => {
      const cat = latest.current.catalog;
      if (!cat) return;
      const { op, select } = addItem(item, pos, cat, viewRect());
      // The new item becomes the selection: its inspector opens instead of the last one's.
      if (apply(op) && select) dispatch({ type: 'select', ...select });
    },
    [apply, viewRect, latest, dispatch],
  );

  /** `workflow`: a named sub-workflow was picked; the new Run node pins its current version. */
  function pickFromSearch(def: NodeInfo, workflow?: WorkflowSummary) {
    const cat = latest.current.catalog;
    const from = search?.from ?? null;
    setSearch(null);
    if (!cat) return;
    const view = viewRect();
    const newId = shortId();
    const pinned: GraphOp = (g) =>
      workflow
        ? setSettings(g, newId, {
            subworkflowId: workflow.id,
            version: workflow.currentVersion,
            overrides: {},
          })
        : { ok: true, graph: g };
    const selectNew = (added: boolean) => {
      if (added) dispatch({ type: 'select', nodes: [newId], edges: [] });
    };
    if (!from) {
      selectNew(
        apply(
          chain([
            (g) => addNode(g, def.type, freeSpot(g, centre(), view), cat, { id: newId }),
            pinned,
          ]),
        ),
      );
      return;
    }
    const input = def.inputs.find((p) => p.type === from.port.type);
    const added = apply(
      chain([
        (g) => {
          const origin = g.nodes.find((n) => n.id === from.nodeId);
          const pos = origin
            ? { x: origin.position.x + NEXT_STEP_X, y: origin.position.y }
            : centre();
          return addNode(g, def.type, freeSpot(g, pos, view), cat, { id: newId });
        },
        pinned,
        (g) =>
          input
            ? connect(
                g,
                { node: from.nodeId, port: from.port.id },
                { node: newId, port: input.id },
                cat,
              )
            : { ok: true, graph: g },
      ]),
    );
    selectNew(added);
  }

  const measuredSizes = useCallback(
    (ids: string[]): Map<string, Size> => {
      const sizes = new Map<string, Size>();
      for (const nodeId of ids) {
        const m = rf.getInternalNode(nodeId)?.measured;
        if (m?.width && m.height) sizes.set(nodeId, { width: m.width, height: m.height });
      }
      return sizes;
    },
    [rf],
  );

  return { clearBox, centre, addFromPalette, pickFromSearch, measuredSizes };
}
