import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Position } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFlow } from '../../test/flow.tsx';
import { TcToolbar, toolbarPlacement } from './TcToolbar.tsx';

afterEach(cleanup);

type Props = Parameters<typeof TcToolbar>[0];

function handlers() {
  return {
    onTry: vi.fn(),
    onDuplicate: vi.fn(),
    onBypass: vi.fn(),
    onDelete: vi.fn(),
  };
}

/** A selected node whose body is the toolbar (React Flow shows a NodeToolbar on selection). */
async function show(props: Omit<Props, 'nodeId'>, selected = true) {
  const node: Node = { id: 'keep', type: 'bar', position: { x: 0, y: 0 }, data: {}, selected };
  const nodeTypes = {
    bar: ({ id }: NodeProps) => <TcToolbar nodeId={id} {...props} />,
  };
  return renderFlow([node], [], { nodeTypes });
}

describe('TcToolbar', () => {
  it('renders the four actions and disables "Try this node" with the hint', async () => {
    const h = handlers();
    await show({ readOnly: false, canTry: false, bypassed: false, ...h });
    const bar = screen.getByRole('toolbar', { name: 'Node actions' });
    expect(bar).toBeTruthy();
    const names = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['Try this node', 'Duplicate', 'Bypass', 'Delete']);
    const tryIt = screen.getByRole('button', { name: 'Try this node' }) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    expect(tryIt.title).toBe('A sub-workflow is tried from a workflow that runs it');
    // A dry run of one node: the same eye as "Dry run on a file".
    expect(tryIt.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('eye');
    fireEvent.click(tryIt);
    expect(h.onTry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bypass', pressed: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.onDuplicate).toHaveBeenCalledTimes(1);
    expect(h.onBypass).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps the name "Bypass" on a bypassed node, pressed, and runs "Try this node" when the engine can', async () => {
    const h = handlers();
    await show({ readOnly: false, canTry: true, bypassed: true, ...h });
    expect(screen.queryByRole('button', { name: 'Un-bypass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bypass', pressed: false })).toBeNull();
    const bypass = screen.getByRole('button', { name: 'Bypass', pressed: true });
    expect(bypass.title).toBe('Bypass');
    expect(bypass.classList).toContain('is-on');
    fireEvent.click(bypass);
    expect(h.onBypass).toHaveBeenCalledTimes(1);
    const tryIt = screen.getByRole('button', { name: 'Try this node' }) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(false);
    expect(tryIt.title).toBe('');
    fireEvent.click(tryIt);
    expect(h.onTry).toHaveBeenCalledTimes(1);
  });

  it('is hidden on a read-only canvas and when the node is not selected', async () => {
    await show({ readOnly: true, canTry: false, bypassed: false, ...handlers() });
    expect(screen.queryByRole('toolbar')).toBeNull();
    cleanup();
    await show({ readOnly: false, canTry: false, bypassed: false, ...handlers() }, false);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});

describe('toolbarPlacement', () => {
  const pane = { width: 900, height: 600 };
  const node = (left: number, top: number, width = 210) => ({
    left,
    right: left + width,
    top,
  });

  it('centres above a node that has room', () => {
    expect(toolbarPlacement(node(400, 200), pane)).toEqual({
      position: Position.Top,
      align: 'center',
    });
  });

  it("aligns to the node's left edge when centring would clip at the pane's left edge", () => {
    expect(toolbarPlacement(node(20, 200), pane)).toEqual({
      position: Position.Top,
      align: 'start',
    });
  });

  it("aligns to the right edge near the pane's right edge", () => {
    expect(toolbarPlacement(node(700, 200), pane)).toEqual({
      position: Position.Top,
      align: 'end',
    });
  });

  it('goes below a node too close to the top', () => {
    expect(toolbarPlacement(node(400, 30), pane)).toEqual({
      position: Position.Bottom,
      align: 'center',
    });
  });
});
