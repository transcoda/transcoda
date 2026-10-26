import { cleanup, fireEvent, render } from '@testing-library/react';
import type { WorkflowGraph } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import type { EditorState } from '../model/editor-state.ts';
import { type EditorKeyActions, useEditorKeys } from './useEditorKeys.ts';

afterEach(cleanup);

function actionsMock() {
  return {
    selectNode: vi.fn<(id: string) => void>(),
    undo: vi.fn<() => void>(),
    redo: vi.fn<() => void>(),
    remove: vi.fn<() => void>(),
    save: vi.fn<() => void>(),
    openSearch: vi.fn<(filter?: string) => void>(),
    connectFrom: vi.fn<(nodeId: string) => void>(),
  } satisfies EditorKeyActions;
}

/** The chain laid out out of order: graph order is by x then y → in, keep, ro. */
function shuffled(): WorkflowGraph {
  const g = chainMainReplace();
  return { ...g, nodes: [g.nodes[2], g.nodes[0], g.nodes[1]].filter((n) => n !== undefined) };
}

function Harness(props: {
  selection: EditorState['selection'];
  actions: EditorKeyActions;
  enabled?: boolean;
}) {
  useEditorKeys({
    enabled: props.enabled ?? true,
    graph: shuffled(),
    selection: props.selection,
    catalog: catalogFixture,
    actions: props.actions,
  });
  return (
    <div>
      <input aria-label="Name" />
      <button type="button">Other</button>
      {/* biome-ignore lint/a11y/useSemanticElements: stands in for a custom switch control. */}
      <div role="switch" aria-checked="false" aria-label="Mode" tabIndex={0} />
      <div className="react-flow">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: stands in for a React Flow node. */}
        <div className="react-flow__node" tabIndex={0} data-testid="node" />
      </div>
    </div>
  );
}

const sel = (...nodes: string[]): EditorState['selection'] => ({ nodes, edges: [] });

describe('useEditorKeys', () => {
  it('Tab cycles the selection in graph order; Delete removes; Mod+Z undoes; "/" opens the search', () => {
    const actions = actionsMock();
    const { rerender, getByTestId } = render(<Harness selection={sel('keep')} actions={actions} />);
    const node = getByTestId('node');
    node.focus();

    fireEvent.keyDown(node, { key: 'Tab' });
    expect(actions.selectNode).toHaveBeenLastCalledWith('ro');
    fireEvent.keyDown(node, { key: 'Tab', shiftKey: true });
    expect(actions.selectNode).toHaveBeenLastCalledWith('in');
    rerender(<Harness selection={sel('ro')} actions={actions} />);
    // No wrap: past the last node Tab falls through to the browser (leaves the canvas).
    expect(fireEvent.keyDown(node, { key: 'Tab' })).toBe(true);
    expect(actions.selectNode).toHaveBeenCalledTimes(2);
    rerender(<Harness selection={sel('in')} actions={actions} />);
    expect(fireEvent.keyDown(node, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(actions.selectNode).toHaveBeenCalledTimes(2);
    rerender(<Harness selection={sel('ro')} actions={actions} />);

    fireEvent.keyDown(node, { key: 'Delete' });
    fireEvent.keyDown(node, { key: 'Backspace' });
    expect(actions.remove).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(node, { key: 'z', metaKey: true });
    expect(actions.undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(node, { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(node, { key: 'y', ctrlKey: true });
    expect(actions.redo).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(node, { key: '/' });
    expect(actions.openSearch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(node, { key: 'c' });
    expect(actions.connectFrom).toHaveBeenCalledWith('ro');

    const save = fireEvent.keyDown(node, { key: 's', metaKey: true });
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(save).toBe(false); // default prevented
  });

  it('keys are ignored while an input or a button has focus, and Tab only acts with a selected node', () => {
    const actions = actionsMock();
    const { getByLabelText, getByRole, rerender, getByTestId } = render(
      <Harness selection={sel('keep')} actions={actions} />,
    );
    const input = getByLabelText('Name');
    input.focus();
    for (const key of ['Tab', 'Delete', 'Backspace', '/', 'c']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'z', metaKey: true });
    const sw = getByRole('switch', { name: 'Mode' });
    sw.focus();
    fireEvent.keyDown(sw, { key: 'Delete' });
    fireEvent.keyDown(sw, { key: 'c' });
    const button = getByRole('button', { name: 'Other' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Delete' });
    fireEvent.keyDown(button, { key: 'Backspace' });
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(actions.selectNode).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
    expect(actions.openSearch).not.toHaveBeenCalled();
    expect(actions.connectFrom).not.toHaveBeenCalled();
    expect(actions.undo).not.toHaveBeenCalled();

    // ⌘S still saves from a field, so the browser's own save dialog never opens.
    fireEvent.keyDown(input, { key: 's', metaKey: true });
    expect(actions.save).toHaveBeenCalledTimes(1);

    // Focus on the page body is not the canvas: Tab stays native.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(true);
    expect(actions.selectNode).not.toHaveBeenCalled();

    rerender(<Harness selection={sel()} actions={actions} />);
    const node = getByTestId('node');
    node.focus();
    expect(fireEvent.keyDown(node, { key: 'Tab' })).toBe(true); // native Tab
    expect(actions.selectNode).not.toHaveBeenCalled();

    rerender(<Harness selection={sel('keep')} actions={actions} enabled={false} />);
    fireEvent.keyDown(node, { key: 'Delete' });
    expect(actions.remove).not.toHaveBeenCalled();
  });
});
