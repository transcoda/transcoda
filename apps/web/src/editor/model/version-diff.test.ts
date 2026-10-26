import type { JsonValue, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { changeLines, diffVersions } from './version-diff.ts';

const node = (id: string, over: Partial<NodeInstance> = {}): NodeInstance => ({
  id,
  type: 'core:test',
  typeVersion: 1,
  settings: {},
  position: { x: 0, y: 0 },
  ...over,
});
const graph = (nodes: NodeInstance[], edges: WorkflowGraph['edges'] = []): WorkflowGraph => ({
  formatVersion: 1,
  kind: 'workflow',
  nodes,
  edges,
  groups: [],
});
const edge = (id: string, from: string, to: string) => ({
  id,
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
});
const titleOf = (n: NodeInstance) => n.label ?? n.type;
const lines = (a: WorkflowGraph, b: WorkflowGraph) => changeLines(diffVersions(a, b, titleOf));

describe('diffVersions', () => {
  it('reports added, removed and changed nodes by title', () => {
    const base = graph([node('a', { label: 'Size gate' }), node('b', { label: 'Video is' })]);
    const next = graph([
      node('b', { label: 'Video is', settings: { codec: 'hevc' } }),
      node('c', { label: 'Encode video' }),
    ]);
    expect(lines(base, next)).toEqual([
      'Added Encode video',
      'Removed Size gate',
      'Changed Video is',
    ]);
  });

  it('reports a Run-node pin move as "Language cleanup 2→3", and a pin plus another setting as changed', () => {
    const run = (settings: JsonValue) =>
      node('r', { type: 'core:run-subworkflow', label: 'Language cleanup', settings });
    expect(
      lines(
        graph([run({ subworkflowId: 's', version: 2 })]),
        graph([run({ subworkflowId: 's', version: 3 })]),
      ),
    ).toEqual(['Language cleanup 2→3']);
    expect(
      lines(
        graph([run({ subworkflowId: 's', version: 2, overrides: {} })]),
        graph([run({ subworkflowId: 's', version: 3, overrides: { a: 1 } })]),
      ),
    ).toEqual(['Changed Language cleanup']);
  });

  it('reports a bypass-only change as changed', () => {
    expect(
      lines(
        graph([node('a', { label: 'Size gate' })]),
        graph([node('a', { label: 'Size gate', bypassed: true })]),
      ),
    ).toEqual(['Changed Size gate']);
  });

  it('reports a Run node going from unpinned to pinned as changed', () => {
    const run = (settings: JsonValue) =>
      node('r', { type: 'core:run-subworkflow', label: 'Language cleanup', settings });
    expect(
      lines(graph([run({ subworkflowId: 's' })]), graph([run({ subworkflowId: 's', version: 2 })])),
    ).toEqual(['Changed Language cleanup']);
  });

  it('reports rewired edges once as "Connections changed", never "Layout only"', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const d = diffVersions(
      graph(nodes, [edge('e1', 'a', 'b')]),
      graph(nodes, [edge('e1', 'a', 'c'), edge('e2', 'b', 'c')]),
      titleOf,
    );
    expect(d.layoutOnly).toBe(false);
    expect(changeLines(d)).toEqual(['Connections changed']);
  });

  it('treats positions, labels and groups alone as "Layout only"; identical graphs give []', () => {
    const base = graph([node('a')]);
    const moved = graph([node('a', { position: { x: 40, y: 8 }, label: 'Renamed' })]);
    expect(lines(base, moved)).toEqual(['Layout only']);
    expect(lines(base, graph([node('a')]))).toEqual([]);
    const grouped = {
      ...base,
      groups: [
        {
          id: 'g',
          name: 'G',
          collapsed: false,
          position: { x: 0, y: 0 },
          size: { width: 1, height: 1 },
        },
      ],
    };
    expect(lines(base, grouped)).toEqual(['Layout only']);
  });
});
