import type { NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { catalogFixture as catalog } from '../../test/fixtures/catalog.ts';
import {
  dropHiddenPortEdges,
  hiddenPortEdges,
  removedNotice,
  shownOutputs,
} from './hidden-ports.ts';

const node = (id: string, type: string, settings: NodeInstance['settings'] = {}): NodeInstance => ({
  id,
  type,
  typeVersion: 1,
  settings,
  position: { x: 0, y: 0 },
});

/** in → Render `r` (Quality check as given); Done → Replace original, Damaged → Notify. */
const rendered = (qualityCheck: boolean): WorkflowGraph => ({
  formatVersion: 2,
  kind: 'workflow',
  nodes: [
    node('in', 'core:input-manual'),
    node('r', 'core:render', { qualityCheck }),
    node('ro', 'core:replace-original'),
    node('nw', 'core:notify-webhook', { url: 'https://hooks.example.com/x' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'in', port: 'file' }, to: { node: 'r', port: 'file' } },
    { id: 'e2', from: { node: 'r', port: 'done' }, to: { node: 'ro', port: 'file' } },
    { id: 'e3', from: { node: 'r', port: 'damaged' }, to: { node: 'nw', port: 'file' } },
  ],
  groups: [],
});

const render = () => catalog.byType.get('core:render');

describe('hidden ports', () => {
  it('shownOutputs hides Damaged while qualityCheck is false and shows it when true', () => {
    const def = render();
    if (!def) throw new Error('no Render in the fixture');
    const ids = (settings: NodeInstance['settings']) =>
      shownOutputs(def, { settings }).map((p) => p.id);
    expect(ids({})).toEqual(['done']);
    expect(ids({ qualityCheck: false })).toEqual(['done']);
    expect(ids({ qualityCheck: true })).toEqual(['done', 'damaged']);
  });

  it('dropHiddenPortEdges removes only edges from hidden outputs and reports them', () => {
    const off = rendered(false);
    expect(hiddenPortEdges(off, catalog).map((e) => e.id)).toEqual(['e3']);
    const { graph, removed } = dropHiddenPortEdges(off, catalog);
    expect(removed.map((e) => e.id)).toEqual(['e3']);
    expect(graph.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(graph.nodes).toBe(off.nodes);
    expect(removedNotice(removed, off, catalog)).toBe('Removed the connection from Damaged');

    const on = rendered(true);
    expect(dropHiddenPortEdges(on, catalog)).toEqual({ graph: on, removed: [] });
  });

  it('removedNotice counts several connections', () => {
    const off = rendered(false);
    const two = {
      ...off,
      edges: [
        ...off.edges,
        { id: 'e4', from: { node: 'r', port: 'damaged' }, to: { node: 'ro', port: 'file' } },
      ],
    };
    const { removed } = dropHiddenPortEdges(two, catalog);
    expect(removedNotice(removed, two, catalog)).toBe('Removed 2 connections from Damaged');
  });
});
