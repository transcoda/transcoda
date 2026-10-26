import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { tidyUp } from '../model/layout.ts';
import { Canvas, type GraphOp } from './Canvas.tsx';

afterEach(cleanup);

async function renderCanvas(
  apply: (op: GraphOp, opts?: unknown) => boolean,
  { readOnly = false, graph = chainMainReplace() } = {},
) {
  const view = render(
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <Canvas
          graph={graph}
          issues={[]}
          selection={{ nodes: ['keep'], edges: [] }}
          catalog={catalogFixture}
          readOnly={readOnly}
          apply={apply}
          onSelect={vi.fn()}
          onRefuse={vi.fn()}
          onDropItem={vi.fn()}
        />
      </div>
    </ReactFlowProvider>,
  );
  await act(async () => {});
  const node = view.container.querySelector('.react-flow__node[data-id="keep"]') as HTMLElement;
  return { node };
}

describe('Canvas', () => {
  it('the minimap can be hidden and shown again from a zoom-control button', async () => {
    await renderCanvas(vi.fn(() => true));
    const map = () => document.querySelector('.react-flow__minimap');
    expect(map()).not.toBeNull();
    const hide = screen.getByRole('button', { name: 'Hide minimap' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(map()).toBeNull();
    const show = screen.getByRole('button', { name: 'Show minimap' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(show);
    expect(map()).not.toBeNull();
  });

  // `keep` sits at x 280; an arrow key nudges the selected node (React Flow, 5 px).
  it('a refused move puts the card back where the graph has it', async () => {
    const apply = vi.fn(() => false);
    const { node } = await renderCanvas(apply);
    expect(node.style.transform).toBe('translate(280px,0px)');
    node.focus();
    await act(async () => {
      fireEvent.keyDown(node, { key: 'ArrowRight' });
    });
    expect(apply).toHaveBeenCalled();
    expect(node.style.transform).toBe('translate(280px,0px)');
  });

  it('an accepted move keeps the card at the new place until the graph catches up', async () => {
    const apply = vi.fn(() => true);
    const { node } = await renderCanvas(apply);
    node.focus();
    await act(async () => {
      fireEvent.keyDown(node, { key: 'ArrowRight' });
    });
    expect(apply).toHaveBeenCalled();
    expect(node.style.transform).toBe('translate(285px,0px)');
  });

  it('"Tidy up" applies the layout as one plain edit (its own undo step)', async () => {
    const apply = vi.fn((_op: GraphOp, _opts?: unknown) => true);
    await renderCanvas(apply);
    fireEvent.click(screen.getByRole('button', { name: 'Tidy up' }));
    expect(apply).toHaveBeenCalledTimes(1);
    const [op, opts] = apply.mock.calls[0] ?? [];
    // No coalescing: it never joins the undo step of a move before it.
    expect(opts).toBeUndefined();
    const g = chainMainReplace();
    expect(op?.(g)).toEqual(tidyUp(g, { catalog: catalogFixture }));
  });

  it('"Tidy up" is disabled read-only and on an empty graph', async () => {
    const apply = vi.fn(() => true);
    await renderCanvas(apply, { readOnly: true });
    const button = screen.getByRole('button', { name: 'Tidy up' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(apply).not.toHaveBeenCalled();
    cleanup();
    await renderCanvas(apply, { graph: { ...chainMainReplace(), nodes: [], edges: [] } });
    expect((screen.getByRole('button', { name: 'Tidy up' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
