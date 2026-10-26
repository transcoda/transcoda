import type { TcEdgeData } from './types.ts';

/**
 * The N7 edge look as pure data: which style an edge takes, the word its accessible name carries
 * and which styles draw an arrowhead. `toFlow` (names) and `TcEdge` (drawing) both read it.
 */
export type EdgeStyle = 'edge-broken' | 'edge-data' | 'edge-path' | 'edge-untaken' | 'edge-file';

/** N7, first match wins: into a broken node, data, path taken (trace), not taken, file flow. */
export function edgeStyle(data: TcEdgeData | undefined): EdgeStyle {
  if (data?.broken) return 'edge-broken';
  if (data?.portType?.startsWith('data:')) return 'edge-data';
  if (data?.taken) return 'edge-path';
  if (data?.untaken) return 'edge-untaken';
  return 'edge-file';
}

const WORDS: Record<EdgeStyle, string | null> = {
  'edge-broken': 'leads to a broken node',
  'edge-data': 'data',
  'edge-path': 'path taken',
  'edge-untaken': 'not taken',
  'edge-file': null,
};

/** The meaning word appended to the edge's accessible name; null for plain file flow. */
export function edgeWord(style: EdgeStyle): string | null {
  return WORDS[style];
}

/** Styles drawn with an arrowhead at the target (N7 "Direction"): every one (Jan, question 4). */
export const ARROWED: ReadonlySet<EdgeStyle> = new Set<EdgeStyle>([
  'edge-file',
  'edge-path',
  'edge-data',
  'edge-untaken',
  'edge-broken',
]);
