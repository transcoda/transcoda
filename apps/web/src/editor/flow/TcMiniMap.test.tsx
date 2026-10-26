import { cleanup, screen } from '@testing-library/react';
import type { Group, Issue, NodeInstance } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { renderFlow } from '../../test/flow.tsx';
import { nodeStateFor } from '../model/issues.ts';
import { nodeTypes } from './nodeTypes.ts';
import { minimapLabel, miniNodeClass, TcMiniMap } from './TcMiniMap.tsx';
import type { TcGroupNode, TcNode } from './types.ts';

afterEach(cleanup);

function tcNode(id: string, type: string, issues: Issue[] = []): TcNode {
  const instance: NodeInstance = {
    id,
    type,
    typeVersion: 1,
    settings: {},
    position: { x: 0, y: 0 },
  };
  return {
    id,
    type: 'tc-node',
    position: { x: 0, y: 0 },
    // The minimap reads the user node's size (toFlow always sets these).
    initialWidth: 210,
    initialHeight: 120,
    data: {
      instance,
      def: catalogFixture.byType.get(type) ?? null,
      state: nodeStateFor(id, issues),
      graphKind: 'workflow',
    },
  };
}

const group: Group = {
  id: 'g1',
  name: 'Audio rules',
  collapsed: false,
  position: { x: 400, y: 0 },
  size: { width: 300, height: 200 },
};

describe('TcMiniMap', () => {
  it('draws each node in its kind colour with its state outline, groups dashed', async () => {
    const issue = (nodeId: string, code: string) =>
      ({ code, severity: 'error', message: 'x', nodeId }) as Issue;
    const groupNode: TcGroupNode = {
      id: 'g1',
      type: 'tc-group',
      position: group.position,
      initialWidth: 300,
      initialHeight: 200,
      style: { width: 300, height: 200 },
      data: { group, count: 0, problem: null },
    };
    await renderFlow(
      [
        groupNode,
        tcNode('keep', 'core:keep-languages'),
        tcNode('enc', 'core:encode-video', [issue('enc', 'NODE_UNAVAILABLE')]),
        tcNode('gone', 'plugin:gone'),
        tcNode('broken', 'core:keep-languages', [issue('broken', 'UNKNOWN_NODE_VERSION')]),
        tcNode('unset', 'core:size-gate', [issue('unset', 'INVALID_SETTINGS')]),
      ],
      [],
      { nodeTypes, children: <TcMiniMap /> },
    );
    const rect = (id: string) =>
      document.querySelector(`.react-flow__minimap [data-id="${id}"]`) as SVGElement | null;
    expect(rect('keep')?.getAttribute('class')).toBe('tc-mini kind-action');
    expect(rect('enc')?.getAttribute('class')).toBe('tc-mini kind-action border-dashed');
    expect(rect('gone')?.getAttribute('class')).toBe('tc-mini kind-unknown');
    expect(rect('broken')?.getAttribute('class')).toBe('tc-mini kind-action border-red');
    expect(rect('unset')?.getAttribute('class')).toBe('tc-mini kind-finish border-amber');
    expect(rect('g1')?.getAttribute('class')).toBe('tc-mini tc-mini-group');
  });

  it('a collapsed group is filled and takes the border of its worst member', () => {
    const tile: TcGroupNode = {
      id: 'g1',
      type: 'tc-group',
      position: group.position,
      data: {
        group: { ...group, collapsed: true },
        count: 2,
        problem: { border: 'red', badge: 'plugin-missing', count: 1, word: 'plugin missing' },
      },
    };
    expect(miniNodeClass(tile).split(' ')).toEqual(
      expect.arrayContaining(['tc-mini-group', 'is-collapsed', 'border-red']),
    );
    const clean: TcGroupNode = { ...tile, data: { ...tile.data, problem: null } };
    expect(miniNodeClass(clean)).toBe('tc-mini tc-mini-group is-collapsed');
  });

  it('draws the values card as a plain card with no state', () => {
    const card = {
      id: '~values',
      type: 'tc-values',
      position: { x: 0, y: 0 },
      data: { values: { position: { x: 0, y: 0 }, entries: [] }, uses: {} },
    };
    expect(miniNodeClass(card)).toBe('tc-mini tc-mini-values');
    expect(minimapLabel([card])).toBe('Minimap');
  });

  it('names how many nodes need attention, hidden ones included', () => {
    const issue = (nodeId: string, code: string) =>
      ({ code, severity: 'error', message: 'x', nodeId }) as Issue;
    expect(minimapLabel([tcNode('keep', 'core:keep-languages')])).toBe('Minimap');
    const hidden = { ...tcNode('a', 'core:keep-languages', [issue('a', 'UNKNOWN_NODE_TYPE')]) };
    hidden.hidden = true;
    expect(minimapLabel([tcNode('keep', 'core:keep-languages'), hidden])).toBe(
      'Minimap, 1 node needs attention',
    );
    expect(
      minimapLabel([
        hidden,
        tcNode('b', 'core:size-gate', [issue('b', 'INVALID_SETTINGS')]),
        tcNode('c', 'core:encode-video', [issue('c', 'NODE_UNAVAILABLE')]),
      ]),
    ).toBe('Minimap, 3 nodes need attention');
  });

  it("the rendered minimap's name says how many nodes need attention", async () => {
    const issue = { code: 'UNKNOWN_NODE_TYPE', severity: 'error', message: 'x', nodeId: 'a' };
    await renderFlow(
      [tcNode('a', 'core:keep-languages', [issue as Issue]), tcNode('b', 'core:size-gate')],
      [],
      { nodeTypes, children: <TcMiniMap /> },
    );
    // React Flow names the minimap's svg (role img) by a <title> through aria-labelledby.
    expect(screen.getByRole('img', { name: 'Minimap, 1 node needs attention' })).toBeTruthy();
  });

  it('is smaller than the library default so it does not take a fifth of the canvas', async () => {
    await renderFlow([], [], { nodeTypes, children: <TcMiniMap /> });
    const map = document.querySelector('.react-flow__minimap') as HTMLElement;
    expect(Number.parseInt(map.style.width, 10)).toBeLessThanOrEqual(150);
    expect(Number.parseInt(map.style.height, 10)).toBeLessThanOrEqual(100);
  });
});
