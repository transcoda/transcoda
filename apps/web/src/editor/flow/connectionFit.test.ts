import type { NodeInfo } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../hooks/useCatalog.ts';
import { nodesFixture } from '../../test/fixtures/catalog.ts';
import { checkConnection } from '../model/connection.ts';
import { connectionFit, type HandleRef, nodeFaded } from './connectionFit.ts';

/** A data source: the core catalogue has `data:language` inputs only, no data output. */
const testLanguage: NodeInfo = {
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

const catalog = buildCatalog([...nodesFixture, testLanguage]);

const node = (id: string, type: string) => ({
  id,
  type,
  typeVersion: 1,
  settings: {},
  position: { x: 0, y: 0 },
});

/** `in` → `keep.file` is wired; `keep.language`, `gate.file` and every output are free. */
const graph: WorkflowGraph = {
  formatVersion: 2,
  kind: 'workflow',
  nodes: [
    node('in', 'core:input-manual'),
    node('keep', 'core:keep-languages'),
    node('gate', 'core:size-gate'),
    node('lang', 'test:language'),
  ],
  edges: [
    { id: 'in-keep', from: { node: 'in', port: 'file' }, to: { node: 'keep', port: 'file' } },
  ],
  groups: [],
};

/** Every handle of the graph, as the canvas sees it. */
const handles: HandleRef[] = graph.nodes.flatMap((n) => {
  const def = catalog.byType.get(n.type);
  if (!def) return [];
  const ins = def.inputs.map(
    (p): HandleRef => ({
      nodeId: n.id,
      portId: p.id,
      direction: 'in',
      portType: p.type,
      occupied: graph.edges.some((e) => e.to.node === n.id && e.to.port === p.id),
    }),
  );
  const outs = def.outputs.map(
    (p): HandleRef => ({
      nodeId: n.id,
      portId: p.id,
      direction: 'out',
      portType: p.type,
      occupied: false,
    }),
  );
  return [...ins, ...outs];
});

const find = (nodeId: string, portId: string, direction: 'in' | 'out') => {
  const h = handles.find(
    (x) => x.nodeId === nodeId && x.portId === portId && x.direction === direction,
  );
  if (!h) throw new Error(`no handle ${nodeId}.${portId} ${direction}`);
  return h;
};

const name = (h: HandleRef) => `${h.nodeId}.${h.portId}(${h.direction})`;

describe('connectionFit', () => {
  it('glows exactly where checkConnection would accept the drop (Review Focus 1)', () => {
    const mismatches: string[] = [];
    for (const from of handles) {
      for (const me of handles) {
        const fit = connectionFit(from, me);
        const accepted =
          from.direction !== me.direction &&
          (from.direction === 'out'
            ? checkConnection(
                graph,
                { node: from.nodeId, port: from.portId },
                { node: me.nodeId, port: me.portId },
                catalog,
              )
            : checkConnection(
                graph,
                { node: me.nodeId, port: me.portId },
                { node: from.nodeId, port: from.portId },
                catalog,
              )
          ).ok;
        if ((fit === 'compatible') !== accepted) {
          mismatches.push(`${name(from)} → ${name(me)}: ${fit}, accepted ${accepted}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('marks the dragged handle as the source and every other handle of its node incompatible', () => {
    const from = find('keep', 'file', 'out');
    expect(connectionFit(from, from)).toBe('source');
    expect(connectionFit(from, find('keep', 'file', 'in'))).toBe('incompatible');
    expect(connectionFit(from, find('keep', 'language', 'in'))).toBe('incompatible');
  });

  it('refuses a type mismatch and an occupied input, accepts a free matching input', () => {
    expect(connectionFit(find('lang', 'language', 'out'), find('gate', 'file', 'in'))).toBe(
      'incompatible',
    );
    expect(connectionFit(find('lang', 'language', 'out'), find('keep', 'language', 'in'))).toBe(
      'compatible',
    );
    expect(connectionFit(find('gate', 'pass', 'out'), find('keep', 'file', 'in'))).toBe(
      'incompatible',
    );
    expect(connectionFit(find('gate', 'pass', 'out'), find('lang', 'language', 'out'))).toBe(
      'incompatible',
    );
  });

  it('dragging from an occupied input: every output is incompatible', () => {
    const from = find('keep', 'file', 'in');
    for (const me of handles.filter((h) => h.direction === 'out')) {
      expect(connectionFit(from, me), name(me)).toBe('incompatible');
    }
  });

  it('is null while nothing is dragged', () => {
    expect(connectionFit(null, find('keep', 'file', 'in'))).toBeNull();
  });

  it('an unknown port type (no catalogue entry) never fits, but stays the source', () => {
    const unknown: HandleRef = {
      nodeId: 'x',
      portId: 'file',
      direction: 'out',
      portType: null,
      occupied: false,
    };
    expect(connectionFit(unknown, find('gate', 'file', 'in'))).toBe('incompatible');
    expect(connectionFit(find('keep', 'file', 'out'), { ...unknown, direction: 'in' })).toBe(
      'incompatible',
    );
    expect(connectionFit(unknown, unknown)).toBe('source');
  });
});

describe('nodeFaded', () => {
  it('fades only while dragging and only when no handle can take the edge', () => {
    expect(nodeFaded([])).toBe(false);
    expect(nodeFaded([null])).toBe(false);
    expect(nodeFaded(['incompatible', 'incompatible'])).toBe(true);
    expect(nodeFaded(['incompatible', 'compatible'])).toBe(false);
    expect(nodeFaded(['source', 'incompatible'])).toBe(false);
  });
});
