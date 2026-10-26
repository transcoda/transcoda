import type { NodeInfo } from '@transcoda/contract';
import type { Issue, IssueCode, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../hooks/useCatalog.ts';
import { catalogFixture, nodesFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace, tiggerPoohMain } from '../../test/fixtures/graphs.ts';
import { NODE_SIZE } from '../model/graph-ops.ts';
import { toFlow, withViewCollapse } from './toFlow.ts';
import type { TcEdge, TcFlowEdge, TcFlowNode, TcGroupNode, TcNode, TraceOverlay } from './types.ts';

const none = { nodes: [], edges: [] };

/** Tigger & Pooh main with the cleanup group at {100,100} and run-a inside it at {160,140}. */
function grouped(collapsed = false): WorkflowGraph {
  const g = tiggerPoohMain('sub', 1);
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === 'run-a'
        ? { ...n, position: { x: 160, y: 140 } }
        : n.id === 'run-b'
          ? { ...n, position: { x: 350, y: 180 } }
          : n,
    ),
    groups: g.groups.map((gr) => ({ ...gr, position: { x: 100, y: 100 }, collapsed })),
  };
}

const flowNode = (nodes: TcFlowNode[], id: string) => {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no flow node ${id}`);
  return found;
};
const flowEdge = (edges: TcFlowEdge[], id: string) => {
  const found = edges.find((e) => e.id === id);
  if (found?.type !== 'tc-edge') throw new Error(`no flow edge ${id}`);
  return found as TcEdge;
};

describe('toFlow', () => {
  it('draws the values card and a dotted line to each node that follows a value', () => {
    const base = chainMainReplace();
    const target = base.nodes[1];
    if (!target) throw new Error('fixture');
    const g: WorkflowGraph = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === target.id ? { ...n, links: { languages: 'Languages', gone: 'Gone' } } : n,
      ),
      values: {
        position: { x: 5, y: -200 },
        entries: [{ name: 'Languages', schema: {}, value: ['en'] }],
      },
    };
    const { nodes, edges } = toFlow(g, catalogFixture, [], { ...none, group: '~values' });
    const card = nodes.find((n) => n.type === 'tc-values');
    expect(card).toMatchObject({
      id: '~values',
      position: { x: 5, y: -200 },
      selected: true,
      data: { uses: { Languages: 1 } },
    });
    const links = edges.filter((e) => e.type === 'tc-link');
    expect(links).toEqual([
      expect.objectContaining({
        id: `~link:${target.id}`,
        source: '~values',
        target: target.id,
        targetHandle: 'value-link',
        selectable: false,
        deletable: false,
        focusable: false,
      }),
    ]);
  });

  it('draws no card and no dotted lines for a graph without values', () => {
    const { nodes, edges } = toFlow(chainMainReplace(), catalogFixture, [], none);
    expect(nodes.some((n) => n.type === 'tc-values')).toBe(false);
    expect(edges.some((e) => e.type === 'tc-link')).toBe(false);
  });

  it('converts grouped node positions to parent-relative and lists group nodes first', () => {
    const { nodes } = toFlow(grouped(), catalogFixture, [], { ...none, group: 'cleanup' });
    expect(nodes[0]?.id).toBe('cleanup');
    const group = flowNode(nodes, 'cleanup') as TcGroupNode;
    expect(group).toMatchObject({
      type: 'tc-group',
      position: { x: 100, y: 100 },
      initialWidth: 400,
      initialHeight: 200,
      style: { width: 400, height: 200 },
      selected: true,
      data: { count: 2, problem: null },
    });
    expect(group.data.group.name).toBe('Cleanup');
    const runA = flowNode(nodes, 'run-a') as TcNode;
    expect(runA).toMatchObject({
      type: 'tc-node',
      parentId: 'cleanup',
      position: { x: 60, y: 40 },
      initialWidth: NODE_SIZE.width,
      initialHeight: NODE_SIZE.height,
      selected: false,
    });
    expect(runA.extent).toBeUndefined();
    expect(runA.hidden).toBeFalsy();
    const ungroupedNode = flowNode(nodes, 'in') as TcNode;
    expect(ungroupedNode.parentId).toBeUndefined();
    expect(ungroupedNode.data.graphKind).toBe('workflow');
    expect(ungroupedNode.data.instance.id).toBe('in');
    expect(ungroupedNode.data.def?.title).toBe(
      catalogFixture.byType.get('core:input-manual')?.title,
    );
  });

  it('a node whose group is missing gets no parent and keeps its absolute position', () => {
    const g = chainMainReplace();
    const withMissing: WorkflowGraph = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'keep' ? { ...n, groupId: 'gone' } : n)),
    };
    const keep = flowNode(toFlow(withMissing, catalogFixture, [], none).nodes, 'keep');
    expect(keep.parentId).toBeUndefined();
    expect(keep.position).toEqual({ x: 280, y: 0 });
  });

  it('names edges by node titles (labels first), with the output port when there are several', () => {
    const g = tiggerPoohMain('sub', 1);
    const run = g.nodes.find((n) => n.id === 'run-a');
    if (run) run.label = 'Languages';
    const { edges } = toFlow(g, catalogFixture, [], none);
    expect(flowEdge(edges, 'in-vi').ariaLabel).toBe('Edge from Manual input to Video is');
    expect(flowEdge(edges, 'vi-run-a').ariaLabel).toBe('Edge from Video is, Yes, to Languages');
    expect(flowEdge(edges, 'vi-ev').ariaLabel).toBe('Edge from Video is, No, to Encode video');
    // The words changed; the stored port ids did not.
    expect(flowEdge(edges, 'vi-run-a').sourceHandle).toBe('pass');
    expect(flowEdge(edges, 'vi-ev').sourceHandle).toBe('else');
  });

  it('selects nodes and edges from the selection', () => {
    const { nodes, edges } = toFlow(chainMainReplace(), catalogFixture, [], {
      nodes: ['keep'],
      edges: ['keep-ro'],
    });
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['keep']);
    expect(edges.filter((e) => e.selected).map((e) => e.id)).toEqual(['keep-ro']);
  });

  it('marks edges into red-bordered nodes broken and labels data edges with their port type', () => {
    const source: NodeInfo = {
      ...(catalogFixture.byType.get('core:keep-languages') as NodeInfo),
      type: 'test:language-source',
      kind: 'data',
      inputs: [],
      outputs: [{ id: 'language', type: 'data:language', label: 'Language' }],
    };
    const catalog = buildCatalog([...nodesFixture, source]);
    const g = chainMainReplace();
    const graph: WorkflowGraph = {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'lang',
          type: 'test:language-source',
          typeVersion: 1,
          settings: {},
          position: { x: 0, y: 200 },
        },
      ],
      edges: [
        ...g.edges,
        {
          id: 'lang-keep',
          from: { node: 'lang', port: 'language' },
          to: { node: 'keep', port: 'language' },
        },
      ],
    };
    const issues: Issue[] = [
      {
        severity: 'error',
        code: 'NODE_NOT_ALLOWED_HERE' as IssueCode,
        message: 'Not allowed here',
        nodeId: 'ro',
      },
    ];
    const { edges } = toFlow(graph, catalog, issues, none);
    expect(flowEdge(edges, 'keep-ro')).toMatchObject({
      type: 'tc-edge',
      source: 'keep',
      target: 'ro',
      sourceHandle: 'file',
      targetHandle: 'file',
      data: { portType: 'file', broken: true },
    });
    expect(flowEdge(edges, 'in-keep').data).toEqual({ portType: 'file', broken: false });
    expect(flowEdge(edges, 'lang-keep')).toMatchObject({
      sourceHandle: 'language',
      targetHandle: 'language',
      data: { portType: 'data:language', broken: false },
    });
  });

  it('marks edges broken from their own edge issues', () => {
    const issues: Issue[] = [
      {
        severity: 'error',
        code: 'PORT_TYPE_MISMATCH' as IssueCode,
        message: 'Port types differ',
        edgeId: 'in-keep',
      },
    ];
    const { edges } = toFlow(chainMainReplace(), catalogFixture, issues, none);
    expect(flowEdge(edges, 'in-keep').data?.broken).toBe(true);
    expect(flowEdge(edges, 'keep-ro').data?.broken).toBe(false);
  });

  it('a node whose def is missing from the catalogue gets def null and keeps its position', () => {
    const g = chainMainReplace();
    const graph: WorkflowGraph = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'keep' ? { ...n, type: 'plugin:gone' } : n)),
    };
    const issues: Issue[] = [
      {
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE' as IssueCode,
        message: 'Unknown node type plugin:gone',
        nodeId: 'keep',
      },
    ];
    const { nodes, edges } = toFlow(graph, catalogFixture, issues, none);
    const keep = flowNode(nodes, 'keep') as TcNode;
    expect(keep.data.def).toBeNull();
    expect(keep.position).toEqual({ x: 280, y: 0 });
    expect(keep.data.state.word).toBe('plugin missing');
    expect(flowEdge(edges, 'keep-ro').data?.portType).toBeNull();
    expect(flowEdge(edges, 'in-keep').data?.broken).toBe(true);
  });

  it('reads "plugin missing" only when no catalogue node shares the namespace', () => {
    const g = chainMainReplace();
    const graph: WorkflowGraph = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'keep' ? { ...n, type: 'acme:x' } : n)),
    };
    const issues: Issue[] = [
      {
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE' as IssueCode,
        message: 'Unknown node type acme:x',
        nodeId: 'keep',
      },
    ];
    const sibling: NodeInfo = {
      ...(catalogFixture.byType.get('core:keep-languages') as NodeInfo),
      type: 'acme:other',
    };
    const installed = buildCatalog([...nodesFixture, sibling]);
    const word = (catalog: typeof installed) =>
      (flowNode(toFlow(graph, catalog, issues, none).nodes, 'keep') as TcNode).data.state.word;
    // The plugin is installed but no longer ships this node.
    expect(word(installed)).toBe('unknown node');
    expect(word(catalogFixture)).toBe('plugin missing');
  });

  it('without a catalogue every node has def null', () => {
    const { nodes, edges } = toFlow(chainMainReplace(), null, [], none);
    expect(nodes.every((n) => n.type === 'tc-node' && n.data.def === null)).toBe(true);
    expect(edges.every((e) => e.data?.portType === null)).toBe(true);
  });

  it('collapsed groups hide their nodes and re-target crossing edges to the group node', () => {
    const { nodes, edges } = toFlow(grouped(true), catalogFixture, [], none);
    expect(flowNode(nodes, 'run-a').hidden).toBe(true);
    expect(flowNode(nodes, 'run-b').hidden).toBe(true);
    expect(flowNode(nodes, 'cleanup').hidden).toBeFalsy();
    expect(flowNode(nodes, 'vi').hidden).toBeFalsy();
    expect(flowEdge(edges, 'vi-run-a')).toMatchObject({
      source: 'vi',
      sourceHandle: 'pass',
      target: 'cleanup',
      targetHandle: 'group',
    });
    expect(flowEdge(edges, 'run-a-ca')).toMatchObject({
      source: 'cleanup',
      sourceHandle: 'group',
      target: 'ca',
      targetHandle: 'file',
    });
    expect(flowEdge(edges, 'in-vi')).toMatchObject({ source: 'in', target: 'vi' });
  });

  it('draws a collapsed group as a 210 x 60 tile and keeps the stored size otherwise', () => {
    const collapsed = flowNode(toFlow(grouped(true), catalogFixture, [], none).nodes, 'cleanup');
    expect(collapsed.style).toEqual({ width: 210, height: 60 });
    expect([collapsed.initialWidth, collapsed.initialHeight]).toEqual([210, 60]);
    const g = grouped(false);
    const open = flowNode(toFlow(g, catalogFixture, [], none).nodes, 'cleanup');
    const size = g.groups[0]?.size;
    expect(open.style).toEqual({ width: size?.width, height: size?.height });
  });

  it("a collapsed group carries its members' worst problem; expanded it carries none", () => {
    const broken: Issue[] = [
      { code: 'UNKNOWN_NODE_TYPE', severity: 'error', message: 'x', nodeId: 'run-a' },
    ];
    const collapsed = flowNode(
      toFlow(grouped(true), catalogFixture, broken, none).nodes,
      'cleanup',
    );
    expect((collapsed as TcGroupNode).data.problem).toMatchObject({ border: 'red', count: 1 });
    const open = flowNode(toFlow(grouped(false), catalogFixture, broken, none).nodes, 'cleanup');
    expect((open as TcGroupNode).data.problem).toBeNull();
    const clean = flowNode(toFlow(grouped(true), catalogFixture, [], none).nodes, 'cleanup');
    expect((clean as TcGroupNode).data.problem).toBeNull();
  });

  it('hides an edge whose both ends are inside the same collapsed group', () => {
    const g = grouped(true);
    const graph: WorkflowGraph = {
      ...g,
      edges: [
        ...g.edges,
        {
          id: 'run-a-run-b',
          from: { node: 'run-a', port: 'file' },
          to: { node: 'run-b', port: 'file' },
        },
      ],
    };
    const { edges } = toFlow(graph, catalogFixture, [], none);
    expect(flowEdge(edges, 'run-a-run-b').hidden).toBe(true);
    expect(flowEdge(edges, 'vi-run-a').hidden).toBeFalsy();
  });

  it('withViewCollapse expands a stored-collapsed group for the view only (read-only canvases)', () => {
    const g = Object.freeze(grouped(true));
    expect(withViewCollapse(g, new Map())).toBe(g);
    const view = withViewCollapse(g, new Map([['cleanup', false]]));
    expect(g.groups[0]?.collapsed).toBe(true);
    expect(view.groups[0]?.collapsed).toBe(false);
    const { nodes } = toFlow(view, catalogFixture, [], none);
    expect(flowNode(nodes, 'run-a').hidden).toBeFalsy();
    expect(
      withViewCollapse(grouped(false), new Map([['cleanup', true]])).groups[0]?.collapsed,
    ).toBe(true);
  });

  it('carries a trace overlay onto node data and edge data', () => {
    const g = tiggerPoohMain('sub', 1);
    const trace: TraceOverlay = {
      nodes: new Map([
        [
          'vi',
          {
            status: 'done',
            reason: 'already HEVC',
            port: 'pass',
            findings: {},
            attempt: 1,
            retried: false,
          },
        ],
      ]),
      edges: new Map([
        ['vi-run-a', { taken: true, untaken: false, value: null }],
        ['vi-ev', { taken: false, untaken: true, value: null }],
        ['in-vi', { taken: false, untaken: false, value: 'ja' }],
      ]),
      currentNodeId: null,
    };
    const { nodes, edges } = toFlow(g, catalogFixture, [], none, trace);
    expect((flowNode(nodes, 'vi') as TcNode).data.trace?.reason).toBe('already HEVC');
    expect((flowNode(nodes, 'ca') as TcNode).data.trace).toBeUndefined();
    expect(flowEdge(edges, 'vi-run-a').data).toMatchObject({ taken: true });
    expect(flowEdge(edges, 'vi-ev').data).toMatchObject({ untaken: true });
    expect(flowEdge(edges, 'in-vi').data?.value).toBe('ja');
    expect(flowEdge(edges, 'run-a-ca').data?.taken).toBeUndefined();
  });

  it('ends an edge name with its meaning word: broken, data, path taken, not taken', () => {
    const source: NodeInfo = {
      ...(catalogFixture.byType.get('core:keep-languages') as NodeInfo),
      type: 'test:language',
      title: 'Language',
      kind: 'data',
      inputs: [],
      outputs: [{ id: 'language', type: 'data:language', label: 'Language' }],
    };
    const catalog = buildCatalog([...nodesFixture, source]);
    const g = chainMainReplace();
    const graph: WorkflowGraph = {
      ...g,
      nodes: [
        ...g.nodes.map((n) => (n.id === 'ro' ? { ...n, type: 'plugin:gone' } : n)),
        {
          id: 'lang',
          type: 'test:language',
          typeVersion: 1,
          settings: {},
          position: { x: 0, y: 200 },
        },
      ],
      edges: [
        ...g.edges,
        {
          id: 'lang-keep',
          from: { node: 'lang', port: 'language' },
          to: { node: 'keep', port: 'language' },
        },
      ],
    };
    const issues: Issue[] = [
      { severity: 'error', code: 'UNKNOWN_NODE_TYPE' as IssueCode, message: 'x', nodeId: 'ro' },
    ];
    const { edges } = toFlow(graph, catalog, issues, none);
    expect(flowEdge(edges, 'keep-ro').ariaLabel).toMatch(
      /^Edge from .+ to .+, leads to a broken node$/,
    );
    expect(flowEdge(edges, 'lang-keep').ariaLabel).toMatch(/^Edge from Language to .+, data$/);
    expect(flowEdge(edges, 'in-keep').ariaLabel).toMatch(/^Edge from [^,]+ to [^,]+$/);

    const trace: TraceOverlay = {
      nodes: new Map(),
      edges: new Map([
        ['vi-run-a', { taken: true, untaken: false, value: null }],
        ['vi-ev', { taken: false, untaken: true, value: null }],
        ['in-vi', { taken: false, untaken: false, value: 'ja' }],
      ]),
      currentNodeId: null,
    };
    const traced = toFlow(tiggerPoohMain('sub', 1), catalogFixture, [], none, trace).edges;
    expect(flowEdge(traced, 'vi-run-a').ariaLabel).toMatch(/, Yes, to .+, path taken$/);
    expect(flowEdge(traced, 'vi-ev').ariaLabel).toMatch(/, No, to .+, not taken$/);
    // Plain file flow keeps its name exactly (a value on it does not make it a data edge).
    expect(flowEdge(traced, 'in-vi').ariaLabel).toBe('Edge from Manual input to Video is');
  });
});
