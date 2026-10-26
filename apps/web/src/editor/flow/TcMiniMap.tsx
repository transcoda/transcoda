import { MiniMap, type MiniMapNodeProps, type Node, useStore } from '@xyflow/react';
import { kindClassOf } from './TcNode.tsx';
import type { TcGroupNode, TcNode } from './types.ts';

/**
 * The minimap rect's classes: kind colour and the N6 border (groups: a dashed outline). A collapsed
 * group is drawn filled (its members are hidden, so React Flow does not draw them) and takes their
 * worst border.
 */
export function miniNodeClass(node: Node): string {
  if (node.type === 'tc-group') {
    const { group, problem } = (node as TcGroupNode).data;
    const classes = ['tc-mini', 'tc-mini-group'];
    if (group.collapsed) classes.push('is-collapsed');
    if (problem) classes.push(`border-${problem.border}`);
    return classes.join(' ');
  }
  // The values card has no kind and no state.
  if (node.type === 'tc-values') return 'tc-mini tc-mini-values';
  const { def, state } = (node as TcNode).data;
  const classes = ['tc-mini', kindClassOf(def)];
  if (state.border) classes.push(`border-${state.border}`);
  return classes.join(' ');
}

function MiniNode({ id, x, y, width, height, className, shapeRendering }: MiniMapNodeProps) {
  return (
    <rect
      data-id={id}
      x={x}
      y={y}
      width={width}
      height={height}
      rx={12}
      className={className}
      shapeRendering={shapeRendering}
    />
  );
}

/** "Minimap", plus how many nodes need attention (hidden ones in a collapsed group included). */
export function minimapLabel(nodes: readonly Node[]): string {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'tc-node' && (node as TcNode).data.state.word !== null) n += 1;
  }
  if (n === 0) return 'Minimap';
  return `Minimap, ${n} ${n === 1 ? 'node needs' : 'nodes need'} attention`;
}

/** Half the library's 200x150 default area, so it doesn't take a fifth of a 640 px canvas. */
const MAP_SIZE = { width: 150, height: 100 };

/** N11: the overview keeps each node's kind colour, so a broken or unready node stands out. */
export function TcMiniMap() {
  // A string, so the minimap re-renders only when the count changes.
  const label = useStore((s) => minimapLabel(s.nodes));
  return (
    <MiniMap
      className="tc-minimap"
      nodeComponent={MiniNode}
      nodeClassName={miniNodeClass}
      ariaLabel={label}
      style={MAP_SIZE}
      pannable
      zoomable
    />
  );
}
