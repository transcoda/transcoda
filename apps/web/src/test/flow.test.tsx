import { cleanup, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFlow } from './flow.tsx';

afterEach(cleanup);

const node = (id: string, x: number): Node => ({
  id,
  position: { x, y: 0 },
  data: { label: `Node ${id}` },
  initialWidth: 210,
  initialHeight: 120,
});

describe('renderFlow (jsdom setup)', () => {
  it('draws visible nodes and the edge between them', async () => {
    const { container } = await renderFlow(
      [node('a', 0), node('b', 400)],
      [{ id: 'a-b', source: 'a', target: 'b' }],
    );
    const card = screen.getByText('Node a').closest('.react-flow__node') as HTMLElement;
    expect(card.style.visibility).toBe('visible');
    expect(container.querySelector('[data-id="a-b"] path.react-flow__edge-path')).not.toBeNull();
  });
});
