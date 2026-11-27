import type { Viewport } from '@xyflow/react';
import { useCallback, useState } from 'react';

const keyFor = (workflowId: string) => `tc.viewport.${workflowId}`;

function isViewport(v: unknown): v is Viewport {
  if (typeof v !== 'object' || v === null) return false;
  const { x, y, zoom } = v as Record<string, unknown>;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof zoom === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(zoom) &&
    zoom > 0
  );
}

function read(workflowId: string): Viewport | undefined {
  try {
    const raw = localStorage.getItem(keyFor(workflowId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isViewport(parsed) || !sameWindow(parsed)) return undefined;
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    // Storage blocked or a value that is not JSON: fit the view instead.
    return undefined;
  }
}

/**
 * A view only fits the window it was saved in: within 15 % of that width and height it is
 * restored, otherwise (another screen, a phone, a resized window) the canvas fits the graph. A
 * value saved before sizes were kept has none and is restored as before.
 */
function sameWindow(v: object): boolean {
  const { w, h } = v as { w?: unknown; h?: unknown };
  if (typeof w !== 'number' || typeof h !== 'number') return true;
  const near = (a: number, b: number) => Math.abs(a - b) <= b * 0.15;
  return near(window.innerWidth, w) && near(window.innerHeight, h);
}

/**
 * The last viewport of a workflow, kept in `localStorage` (`tc.viewport.<id>`, JSON {x,y,zoom}
 * plus the window's w and h). `defaultViewport` is read once per mount; undefined → the canvas
 * fits the graph.
 */
export function useViewportMemory(workflowId: string): {
  defaultViewport: Viewport | undefined;
  onMoveEnd(e: unknown, viewport: Viewport): void;
} {
  const [defaultViewport] = useState(() => read(workflowId));
  const onMoveEnd = useCallback(
    (_e: unknown, viewport: Viewport) => {
      try {
        const { x, y, zoom } = viewport;
        const size = { w: window.innerWidth, h: window.innerHeight };
        localStorage.setItem(keyFor(workflowId), JSON.stringify({ x, y, zoom, ...size }));
      } catch {
        // Storage full or blocked: the viewport is a convenience, not data.
      }
    },
    [workflowId],
  );
  return { defaultViewport, onMoveEnd };
}
