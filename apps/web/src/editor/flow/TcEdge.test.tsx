import { cleanup, render } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ARROW_SIZE, TcEdge } from './TcEdge.tsx';
import type { TcEdgeData } from './types.ts';

afterEach(cleanup);

function draw(id: string, data: TcEdgeData) {
  const { container } = render(
    <ReactFlowProvider>
      <svg aria-hidden="true">
        <TcEdge
          id={id}
          source="a"
          target="b"
          sourceX={0}
          sourceY={0}
          targetX={300}
          targetY={100}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
          data={data}
          type="tc-edge"
          selected={false}
          animated={false}
          deletable
          selectable
        />
      </svg>
    </ReactFlowProvider>,
  );
  const path = container.querySelector('path.react-flow__edge-path') as SVGPathElement;
  return { container, path };
}

describe('TcEdge', () => {
  it('uses edge-broken, edge-data and edge-file classes by data', () => {
    const file = draw('f', { portType: 'file', broken: false });
    expect(file.path.classList.contains('edge-file')).toBe(true);
    expect(file.path.getAttribute('d')).toMatch(/^M ?0,? ?0 ?C/);
    expect(file.path.getAttribute('marker-end')).toBe('url(#tc-arrow-f)');
    expect(file.container.querySelector('marker#tc-arrow-f')).not.toBeNull();
    cleanup();

    const data = draw('d', { portType: 'data:language', broken: false });
    expect(data.path.classList.contains('edge-data')).toBe(true);
    expect(data.path.getAttribute('marker-end')).toBe('url(#tc-arrow-d)');
    expect(data.container.querySelector('marker#tc-arrow-d.tc-arrow.edge-data')).not.toBeNull();
    cleanup();

    // Broken wins over the port type.
    const broken = draw('b', { portType: 'data:language', broken: true });
    expect(broken.path.classList.contains('edge-broken')).toBe(true);
    expect(broken.path.classList.contains('edge-data')).toBe(false);
    expect(broken.path.getAttribute('marker-end')).toBe('url(#tc-arrow-b)');
    expect(broken.container.querySelector('marker#tc-arrow-b.tc-arrow.edge-broken')).not.toBeNull();
    cleanup();

    const unknown = draw('u', { portType: null, broken: false });
    expect(unknown.path.classList.contains('edge-file')).toBe(true);
  });

  it('draws trace edges with an arrow: taken, and untaken grey dashed', () => {
    const taken = draw('t', { portType: 'file', broken: false, taken: true });
    expect(taken.path.classList.contains('edge-path')).toBe(true);
    expect(taken.path.getAttribute('marker-end')).toBe('url(#tc-arrow-t)');
    cleanup();

    const untaken = draw('n', { portType: 'file', broken: false, untaken: true });
    expect(untaken.path.classList.contains('edge-untaken')).toBe(true);
    expect(untaken.path.getAttribute('marker-end')).toBe('url(#tc-arrow-n)');
    expect(
      untaken.container.querySelector('marker#tc-arrow-n.tc-arrow.edge-untaken'),
    ).not.toBeNull();
  });

  it('draws one marker per edge, with an id safe for url()', () => {
    const { container, path } = draw('a:b/c', { portType: 'file', broken: false });
    expect(container.querySelectorAll('marker')).toHaveLength(1);
    expect(path.getAttribute('marker-end')).toBe('url(#tc-arrow-a_b_c)');
  });

  it('sizes the arrowhead in user space, so a thin data edge gets the same arrow as a thick one', () => {
    const sizes = (['f', 'd', 't'] as const).map((id) => {
      const data: TcEdgeData =
        id === 'd'
          ? { portType: 'data:language', broken: false }
          : { portType: 'file', broken: false, taken: id === 't' };
      const { container } = draw(id, data);
      const marker = container.querySelector('marker') as SVGMarkerElement;
      const attrs = ['markerUnits', 'markerWidth', 'markerHeight'].map((a) =>
        marker.getAttribute(a),
      );
      cleanup();
      return attrs;
    });
    for (const attrs of sizes)
      expect(attrs).toEqual(['userSpaceOnUse', String(ARROW_SIZE), String(ARROW_SIZE)]);
  });
});
