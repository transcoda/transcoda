import { NodeToolbar, Position, type ReactFlowState, useStore } from '@xyflow/react';
import type { KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon.tsx';

/** The toolbar's drawn size (Try this node + three icon buttons; 34 px tall + padding) and gaps. */
const BAR_WIDTH = 300;
const BAR_HEIGHT = 52;
const EDGE_GAP = 8;

type Placement = { position: Position; align: 'start' | 'center' | 'end' };

/**
 * Where the toolbar goes for a node whose box (`left`, `right`, `top`) is given in pane pixels:
 * centred above it, unless that would clip at the pane's left or right edge (then flush with the
 * node's left or right edge) or the node is too near the top (then below it).
 */
export function toolbarPlacement(
  node: { left: number; right: number; top: number },
  pane: { width: number },
): Placement {
  const centre = (node.left + node.right) / 2;
  const align =
    centre - BAR_WIDTH / 2 < EDGE_GAP
      ? 'start'
      : centre + BAR_WIDTH / 2 > pane.width - EDGE_GAP
        ? 'end'
        : 'center';
  const position = node.top - BAR_HEIGHT < EDGE_GAP ? Position.Bottom : Position.Top;
  return { position, align };
}

/** The placement for `nodeId` as one string, so the store re-renders the toolbar only on a change. */
function placementKey(nodeId: string) {
  return (s: ReactFlowState): string => {
    const n = s.nodeLookup.get(nodeId);
    if (!n || s.width === 0) return 'top/center';
    const [tx, ty, zoom] = s.transform;
    const width = (n.measured.width ?? n.width ?? 0) * zoom;
    const left = n.internals.positionAbsolute.x * zoom + tx;
    const top = n.internals.positionAbsolute.y * zoom + ty;
    const p = toolbarPlacement({ left, right: left + width, top }, { width: s.width });
    return `${p.position}/${p.align}`;
  };
}

function usePlacement(nodeId: string): Placement {
  const key = useStore(placementKey(nodeId));
  const [position, align] = key.split('/') as [Position, Placement['align']];
  return { position, align };
}

export const TRY_BLOCKED = 'A sub-workflow is tried from a workflow that runs it';

/**
 * N8: the selected node's actions above the card (React Flow shows it while the node is the only
 * one selected), kept inside the canvas by `toolbarPlacement`. Hidden on a read-only canvas. "Try this node" dry-runs the workflow on a file and
 * opens the job at this node (Task 24); a sub-workflow cannot be tried on its own.
 */
export function TcToolbar({
  nodeId,
  readOnly,
  canTry,
  onTry,
  onDuplicate,
  onBypass,
  bypassed,
  onDelete,
}: {
  nodeId: string;
  readOnly: boolean;
  canTry: boolean;
  onTry(): void;
  onDuplicate(): void;
  onBypass(): void;
  bypassed: boolean;
  onDelete(): void;
}) {
  const { position, align } = usePlacement(nodeId);
  if (readOnly) return null;
  // The toolbar renders inside the node in React's tree, so its keys would reach React Flow's node
  // handler (Escape deselects, arrows nudge). `nokey` makes React Flow ignore them; Escape returns
  // focus to the node, which stays selected.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
        ?.focus();
    } else if (e.key.startsWith('Arrow')) {
      e.stopPropagation();
    }
  }
  return (
    <NodeToolbar nodeId={nodeId} position={position} align={align}>
      <div
        role="toolbar"
        aria-label="Node actions"
        className="tc-toolbar nodrag nopan nokey"
        data-node-id={nodeId}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          className="tc-toolbar-btn tc-toolbar-try"
          disabled={!canTry}
          title={canTry ? undefined : TRY_BLOCKED}
          onClick={onTry}
        >
          <Icon name="eye" size={11} strokeWidth={2.6} />
          Try this node
        </button>
        <button
          type="button"
          className="tc-toolbar-btn"
          aria-label="Duplicate"
          title="Duplicate"
          onClick={onDuplicate}
        >
          <Icon name="copy" size={13} />
        </button>
        <button
          type="button"
          className={`tc-toolbar-btn${bypassed ? ' is-on' : ''}`}
          aria-label="Bypass"
          aria-pressed={bypassed}
          title="Bypass"
          onClick={onBypass}
        >
          <Icon name="bypass" size={13} />
        </button>
        <button
          type="button"
          className="tc-toolbar-btn tc-toolbar-delete"
          aria-label="Delete"
          title="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </NodeToolbar>
  );
}

/**
 * Two or more selected cards: one toolbar above the whole selection (rendered by the first
 * selected card) with "Group N nodes" and "Delete N nodes". Hidden on a read-only canvas.
 */
export function TcSelectionToolbar({
  nodeIds,
  readOnly,
  onGroup,
  onDelete,
}: {
  nodeIds: string[];
  readOnly: boolean;
  onGroup(): void;
  onDelete(): void;
}) {
  if (readOnly || nodeIds.length < 2) return null;
  const n = nodeIds.length;
  return (
    <NodeToolbar nodeId={nodeIds} isVisible position={Position.Top}>
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="tc-toolbar nodrag nopan nokey"
        onKeyDown={(e) => {
          // Arrows would nudge the selected cards (React Flow's node keys).
          if (e.key.startsWith('Arrow')) e.stopPropagation();
        }}
      >
        <button type="button" className="tc-toolbar-btn has-text" onClick={onGroup}>
          Group {n} nodes
        </button>
        <button
          type="button"
          className="tc-toolbar-btn has-text tc-toolbar-delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={13} />
          Delete {n} nodes
        </button>
      </div>
    </NodeToolbar>
  );
}
