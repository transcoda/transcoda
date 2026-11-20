import { type ReactFlowState, useStore } from '@xyflow/react';
import { useLayoutEffect } from 'react';

const zoomOf = (s: ReactFlowState): number => s.transform[2];
const domOf = (s: ReactFlowState): HTMLDivElement | null => s.domNode;

/**
 * Writes the canvas zoom to `--tc-zoom` on the React Flow wrapper, so CSS can keep a small
 * on-canvas button (the "+" and the group toggle) at least 24 px on screen (WCAG 2.5.8) when the
 * canvas is zoomed out: see `--tc-hit` in styles.css. Renders nothing.
 */
export function ZoomVar() {
  const zoom = useStore(zoomOf);
  const dom = useStore(domOf);
  useLayoutEffect(() => {
    dom?.style.setProperty('--tc-zoom', String(zoom));
  }, [dom, zoom]);
  return null;
}
