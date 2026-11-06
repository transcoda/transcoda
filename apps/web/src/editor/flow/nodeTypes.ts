import { TcEdge } from './TcEdge.tsx';
import { TcGroup } from './TcGroup.tsx';
import { TcLinkEdge } from './TcLinkEdge.tsx';
import { TcNode } from './TcNode.tsx';
import { TcValues } from './TcValues.tsx';

// Module constants: React Flow warns when these objects change between renders.
export const nodeTypes = { 'tc-node': TcNode, 'tc-group': TcGroup, 'tc-values': TcValues };
export const edgeTypes = { 'tc-edge': TcEdge, 'tc-link': TcLinkEdge };

/**
 * React Flow's control names in sentence case, like the rest of the UI ("Zoom in", not its
 * default "Zoom In"); the zoom buttons use them as their title too.
 */
export const ARIA_LABELS = {
  'controls.ariaLabel': 'Canvas controls',
  'controls.zoomIn.ariaLabel': 'Zoom in',
  'controls.zoomOut.ariaLabel': 'Zoom out',
  'controls.fitView.ariaLabel': 'Fit view',
  'controls.interactive.ariaLabel': 'Lock the canvas',
  'minimap.ariaLabel': 'Minimap',
} as const;
