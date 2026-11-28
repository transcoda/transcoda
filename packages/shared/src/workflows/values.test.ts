import { describe, expect, it } from 'vitest';
import { type WorkflowGraph, WorkflowGraphSchema } from './graph.ts';
import { linkedNodes, syncLinkedSettings, valueNamed } from './values.ts';

const LANGS = { type: 'array', items: { type: 'string' } };

function graph(over: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    formatVersion: 2,
    kind: 'workflow',
    nodes: [
      {
        id: 'keep',
        type: 'core:keep-languages',
        typeVersion: 1,
        settings: { languages: ['en'], keepOriginal: true },
        position: { x: 0, y: 0 },
        links: { languages: 'Languages' },
      },
      {
        id: 'order',
        type: 'core:reorder-tracks',
        typeVersion: 1,
        settings: { languages: ['fr'] },
        position: { x: 300, y: 0 },
      },
    ],
    edges: [],
    groups: [],
    values: {
      position: { x: 0, y: -200 },
      entries: [{ name: 'Languages', schema: LANGS, value: ['en', 'de'] }],
    },
    ...over,
  };
}

describe('the graph format', () => {
  it('keeps notes, values and links when a graph is parsed', () => {
    const g = graph({
      groups: [
        {
          id: 'g1',
          name: 'Start here',
          collapsed: false,
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          note: '**Change** the languages',
        },
      ],
    });
    const parsed = WorkflowGraphSchema.parse(g);
    expect(parsed.groups[0]?.note).toBe('**Change** the languages');
    expect(parsed.values?.entries[0]?.name).toBe('Languages');
    expect(parsed.nodes[0]?.links).toEqual({ languages: 'Languages' });
  });

  it('still parses a graph without any of them', () => {
    const g = graph();
    delete g.values;
    delete g.nodes[0]?.links;
    expect(WorkflowGraphSchema.safeParse(g).success).toBe(true);
  });

  it('refuses two values with the same name', () => {
    const g = graph();
    g.values?.entries.push({ name: 'Languages', schema: LANGS, value: ['fr'] });
    expect(WorkflowGraphSchema.safeParse(g).success).toBe(false);
  });
});

describe('syncLinkedSettings', () => {
  it('copies each linked value into the node settings', () => {
    const out = syncLinkedSettings(graph());
    expect(out.nodes[0]?.settings).toEqual({ languages: ['en', 'de'], keepOriginal: true });
  });

  it('leaves unlinked nodes and links to a missing value alone', () => {
    const g = graph();
    if (g.nodes[1]) g.nodes[1].links = { languages: 'Gone' };
    const out = syncLinkedSettings(g);
    expect(out.nodes[1]?.settings).toEqual({ languages: ['fr'] });
  });

  it('returns the same graph when nothing changes', () => {
    const once = syncLinkedSettings(graph());
    expect(syncLinkedSettings(once)).toBe(once);
  });
});

describe('lookups', () => {
  it('finds a value by name and the nodes linked to it', () => {
    const g = graph();
    expect(valueNamed(g, 'Languages')?.value).toEqual(['en', 'de']);
    expect(valueNamed(g, 'Nope')).toBeUndefined();
    expect(linkedNodes(g, 'Languages').map((n) => n.id)).toEqual(['keep']);
  });
});
