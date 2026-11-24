import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react';

/**
 * The lowest zoom a canvas opens at. 75 % is where the full card comes back (N9, see
 * useZoomLevel): titles (15 px) land at about 11 px on screen, the smallest size the UI sets
 * text in, and the port labels and on-node controls are shown. A fit-all below it leaves
 * titles at 5 to 6 px, too small to read.
 */
export const READABLE_ZOOM = 0.75;

/**
 * A fit padding as React Flow 12 read a plain number `p`: the graph gets 1 / (1 + p) of the pane,
 * half the rest on each side (0.2 leaves 8.3 % per side). React Flow 13 reads a plain number as
 * pixels, so the canvases pass this percentage to `fitView` to keep the fit they had.
 */
export function fitPadding(p: number): `${number}%` {
  return `${(50 * p) / (1 + p)}%`;
}

/**
 * The same padding in whole pixels for a `width` x `height` pane, rounded as React Flow 12
 * rounded it: for `getViewportForBounds`, where the pane size is known.
 */
export function fitPaddingPx(p: number, width: number, height: number): { x: number; y: number } {
  const side = (length: number) => Math.floor((length - length / (1 + p)) * 0.5);
  return { x: side(width), y: side(height) };
}

/** Space (screen px) kept between the pane's left edge and the trigger when the graph is cut. */
const OPEN_PAD = 48;

/**
 * The viewport a canvas opens at: the whole graph (`fit`, at most `maxZoom`, with `padding` read
 * as in `fitPadding`) when that is at `floor` or above; otherwise `floor`, with the trigger
 * (`anchor`) `OPEN_PAD` in from the left so the flow reads on to the right. Vertically the graph
 * is centred when it fits at that zoom, else the trigger is.
 */
export function openViewport(
  bounds: Rect,
  anchor: Rect,
  pane: { width: number; height: number },
  { maxZoom = 1, padding = 0.2, floor = READABLE_ZOOM } = {},
): Viewport {
  const fit = getViewportForBounds(
    bounds,
    pane.width,
    pane.height,
    0,
    maxZoom,
    fitPaddingPx(padding, pane.width, pane.height),
  );
  if (fit.zoom >= floor) return fit;
  const zoom = floor;
  const graphFits = bounds.height * zoom <= pane.height - 2 * OPEN_PAD;
  const centreY = graphFits ? bounds.y + bounds.height / 2 : anchor.y + anchor.height / 2;
  return { x: OPEN_PAD - anchor.x * zoom, y: pane.height / 2 - centreY * zoom, zoom };
}

/** A card or group as the canvas holds it: `x`/`y` relative to its parent group, if any. */
export type OpenBox = {
  id: string;
  parentId?: string | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The rectangle around every shown card and group, in canvas coordinates: a group member's
 * parent-relative position is made absolute through its parent chain, so a member that sits past
 * its group's edge is still inside the first view. `null` when there is nothing to show.
 */
export function openBounds(boxes: readonly OpenBox[]): Rect | null {
  if (boxes.length === 0) return null;
  const byId = new Map(boxes.map((b) => [b.id, b] as const));
  const absolute = (b: OpenBox): { x: number; y: number } => {
    let { x, y } = b;
    const seen = new Set([b.id]);
    let parent = b.parentId !== undefined ? byId.get(b.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      x += parent.x;
      y += parent.y;
      parent = parent.parentId !== undefined ? byId.get(parent.parentId) : undefined;
    }
    return { x, y };
  };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    const { x, y } = absolute(b);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + b.width);
    maxY = Math.max(maxY, y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
