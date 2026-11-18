import { type ReactFlowState, useStore } from '@xyflow/react';

/** N9: ≥ 0.75 the full card; 0.40–0.75 icon + name with on-node controls as summary; < 0.40 a circle with the icon. */
export type ZoomLevel = 'full' | 'compact' | 'icon';

const levelOf = (s: ReactFlowState): ZoomLevel => {
  const zoom = s.transform[2];
  if (zoom >= 0.75) return 'full';
  return zoom >= 0.4 ? 'compact' : 'icon';
};

/** The canvas's detail level; re-renders only when the level changes, not on every zoom step. */
export function useZoomLevel(): ZoomLevel {
  return useStore(levelOf);
}

/** On-screen size (px) a counter-scaled icon aims for: the icon tile's glyph, the compact eyebrow's. */
const ICON_TARGET = { icon: { base: 28, px: 16 }, compact: { base: 11, px: 7.5 } } as const;
/** The icon level's glyph stays within 49 px of the 80 px circle; the compact eyebrow's within 22 px. */
const MAX_ICON_SCALE = { icon: 1.75, compact: 2 } as const;
const SCALE_STEP = 0.25;

/** The job page's trace draws its icon tiles twice as large (a 160 px circle, a 30 px glyph on screen). */
export const TRACE_ICON = { circle: 160, target: { base: 28, px: 30 }, maxScale: 3.5 } as const;

/**
 * How much to enlarge a node icon at `zoom` so it stays recognisable when the canvas is zoomed
 * out: the factor that brings it to its target on-screen size, in quarter steps (so the cards
 * re-render a few times over a whole zoom range, not on every wheel tick), at most 2x on the
 * compact eyebrow and 1.75x in the icon level's 80 px circle. The full card is never scaled.
 */
export function iconScale(zoom: number, level: ZoomLevel, trace = false): number {
  if (level === 'full') return 1;
  const big = trace && level === 'icon';
  const { base, px } = big ? TRACE_ICON.target : ICON_TARGET[level];
  const raw = px / (base * zoom);
  return Math.min(
    big ? TRACE_ICON.maxScale : MAX_ICON_SCALE[level],
    Math.max(1, Math.ceil(raw / SCALE_STEP - 1e-9) * SCALE_STEP),
  );
}

/** The icon enlargement for the canvas's current zoom (a number, so the store compares by value). */
export function useIconScale(trace = false): number {
  return useStore((s: ReactFlowState) => iconScale(s.transform[2], levelOf(s), trace));
}
