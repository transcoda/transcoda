// The editor page's selection: what is selected, the field the inspector focuses, and an issue
// or a node brought into view.
import { getViewportForBounds, useReactFlow, useReactFlowStoreApi } from '@xyflow/react';
import { type Dispatch, type RefObject, useCallback, useEffect, useState } from 'react';
import { fitPaddingPx } from '../flow/open-viewport.ts';
import type { EditorAction, EditorState } from '../model/editor-state.ts';
import { removeSelection } from '../model/graph-ops.ts';
import { FIT_VIEW, type GraphOp } from '../ui/Canvas.tsx';
import type { IssueTarget } from '../ui/IssuesPanel.tsx';
import type { EditorLatest } from './use-editor-save.ts';

const nodeElement = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

export function useEditorSelection({
  selection,
  latest,
  apply,
  dispatch,
  canvasRef,
  clearBox,
}: {
  selection: EditorState['selection'] | undefined;
  latest: RefObject<EditorLatest>;
  apply(op: GraphOp): boolean;
  dispatch: Dispatch<EditorAction>;
  canvasRef: RefObject<HTMLDivElement | null>;
  /** The canvas area cards can be seen in, on screen. */
  clearBox(): { left: number; top: number; right: number; bottom: number } | null;
}) {
  const rf = useReactFlow();
  const store = useReactFlowStoreApi();
  /**
   * A field the inspector focuses once its target is the selection: a node's setting (issues
   * panel, on-node row) or a new group's `name`.
   */
  const [focusRequest, setFocusRequest] = useState<{ targetId: string; key: string } | null>(null);

  /** Select a node and focus one of its settings in the inspector. */
  const focusField = useCallback(
    (nodeId: string, key: string) => {
      dispatch({ type: 'select', nodes: [nodeId], edges: [] });
      setFocusRequest({ targetId: nodeId, key });
    },
    [dispatch],
  );

  const onSelect = useCallback(
    (next: { nodes: string[]; edges: string[]; group?: string }) =>
      dispatch({ type: 'select', ...next }),
    [dispatch],
  );

  /** Select one node and move keyboard focus to it (React Flow pans to a focused node). */
  const selectNode = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'select', nodes: [nodeId], edges: [] });
      nodeElement(nodeId)?.focus();
    },
    [dispatch],
  );

  const removeSelected = useCallback(() => {
    const sel = latest.current.state?.selection;
    if (sel) apply((g) => removeSelection(g, sel));
  }, [apply, latest]);

  /** An issues panel entry: select and centre its node or edge (and focus the setting). */
  const focusIssue = useCallback(
    (target: IssueTarget) => {
      const g = latest.current.state?.draft;
      if (!g) return;
      const visible = (nodeId: string) => {
        const node = g.nodes.find((n) => n.id === nodeId);
        const group = g.groups.find((gr) => gr.id === node?.groupId);
        return group?.collapsed ? group.id : nodeId;
      };
      // Direct viewport math: React Flow's fitView is queued until the next node update.
      const centreOn = (ids: string[]) => {
        const { width, height } = store.viewportStore.getState();
        const { minZoom } = store.optionsStore.getState();
        if (ids.length === 0 || width === 0 || height === 0) return;
        // Fit into the part of the canvas the banners and bottom controls leave clear.
        const wrapTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
        const box = clearBox();
        const insetTop = box ? box.top - wrapTop : 0;
        const clearHeight = box ? box.bottom - box.top : height;
        const bounds = rf.getNodesBounds(ids);
        const fitHeight = clearHeight > 0 ? clearHeight : height;
        const viewport = getViewportForBounds(
          bounds,
          width,
          fitHeight,
          minZoom,
          FIT_VIEW.maxZoom,
          fitPaddingPx(0.4, width, fitHeight),
        );
        void rf.setViewport({ ...viewport, y: viewport.y + insetTop }, { duration: 200 });
      };
      if (target.nodeId !== undefined && g.nodes.some((n) => n.id === target.nodeId)) {
        if (target.settingPath !== undefined) focusField(target.nodeId, target.settingPath);
        else dispatch({ type: 'select', nodes: [target.nodeId], edges: [] });
        centreOn([visible(target.nodeId)]);
        return;
      }
      const edge = g.edges.find((e) => e.id === target.edgeId);
      if (edge) {
        dispatch({ type: 'select', nodes: [], edges: [edge.id] });
        centreOn([visible(edge.from.node), visible(edge.to.node)]);
        return;
      }
      centreOn([...new Set(g.nodes.map((n) => visible(n.id)))]);
    },
    [rf, store, focusField, clearBox, canvasRef, dispatch, latest],
  );

  const onFocused = useCallback(() => setFocusRequest(null), []);
  const sel = selection;
  const [onlySelected] = sel?.nodes ?? [];
  const focusTarget =
    focusRequest !== null &&
    sel !== undefined &&
    (sel.nodes.length === 1
      ? onlySelected === focusRequest.targetId
      : sel.nodes.length === 0 && sel.group === focusRequest.targetId)
      ? focusRequest.key
      : null;
  // A request for a target that is no longer the selection is dropped, not kept for later.
  useEffect(() => {
    if (focusRequest !== null && focusTarget === null) setFocusRequest(null);
  }, [focusRequest, focusTarget]);

  return {
    focusTarget,
    onFocused,
    focusField,
    setFocusRequest,
    onSelect,
    selectNode,
    removeSelected,
    focusIssue,
  };
}
