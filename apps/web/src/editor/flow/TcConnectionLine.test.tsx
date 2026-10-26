import { cleanup, render } from '@testing-library/react';
import type { NodeInfo } from '@transcoda/contract';
import {
  type ConnectionLineComponentProps,
  ConnectionLineType,
  type InternalNode,
  Position,
  ReactFlowProvider,
} from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { TcConnectionLine } from './TcConnectionLine.tsx';
import type { TcGroupNode, TcNode } from './types.ts';

afterEach(cleanup);

const testLanguage = {
  type: 'test:language',
  version: 1,
  kind: 'data',
  title: 'Original language',
  description: 'The language a title was made in.',
  icon: 'languages',
  inputs: [],
  outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
  settingsSchema: { type: 'object', properties: {} },
  onNodeSettings: [],
  source: { kind: 'plugin', name: 'test', version: '0.1.0' },
  availability: { available: true },
} as NodeInfo;

type FlowNode = TcNode | TcGroupNode;

function line(
  def: NodeInfo | null,
  handle: { id: string; type: 'source' | 'target' },
  status: 'valid' | 'invalid' | null = null,
) {
  const fromNode = {
    id: 'a',
    type: 'tc-node',
    position: { x: 0, y: 0 },
    data: def ? { def } : {},
  } as unknown as InternalNode<FlowNode>;
  const props: ConnectionLineComponentProps<FlowNode> = {
    connectionLineType: ConnectionLineType.Bezier,
    fromNode,
    fromHandle: {
      id: handle.id,
      nodeId: 'a',
      type: handle.type,
      position: Position.Right,
      x: 0,
      y: 0,
      width: 14,
      height: 14,
    },
    fromX: 0,
    fromY: 0,
    toX: 200,
    toY: 50,
    fromPosition: Position.Right,
    toPosition: Position.Left,
    connectionStatus: status,
    toNode: null,
    toHandle: null,
    pointer: { x: 200, y: 50 },
  };
  const { container } = render(
    <ReactFlowProvider>
      <svg>
        <title>connection</title>
        <TcConnectionLine {...props} />
      </svg>
    </ReactFlowProvider>,
  );
  const path = container.querySelector('path');
  if (!path) throw new Error('no path');
  return path;
}

describe('TcConnectionLine', () => {
  it('draws a dragged data edge as the data style', () => {
    const path = line(testLanguage, { id: 'language', type: 'source' });
    expect(path.getAttribute('class')).toBe('tc-connection-line edge-data');
    expect(path.getAttribute('fill')).toBe('none');
    expect(path.getAttribute('d')).toMatch(/^M/);
  });

  it('draws a dragged file edge as the file style, also from an input', () => {
    const keep = catalogFixture.byType.get('core:keep-languages') ?? null;
    expect(line(keep, { id: 'file', type: 'source' }).getAttribute('class')).toBe(
      'tc-connection-line edge-file',
    );
    cleanup();
    expect(line(keep, { id: 'language', type: 'target' }).getAttribute('class')).toBe(
      'tc-connection-line edge-data',
    );
  });

  it('adds is-valid over a handle that accepts the drop', () => {
    const keep = catalogFixture.byType.get('core:keep-languages') ?? null;
    expect(line(keep, { id: 'file', type: 'source' }, 'valid').getAttribute('class')).toBe(
      'tc-connection-line edge-file is-valid',
    );
  });

  it('falls back to the file style for a node without a catalogue entry', () => {
    expect(line(null, { id: 'file', type: 'source' }).getAttribute('class')).toBe(
      'tc-connection-line edge-file',
    );
  });
});
