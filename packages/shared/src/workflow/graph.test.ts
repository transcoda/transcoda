import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  emptyGraph,
  hasErrors,
  RunSubworkflowSettingsSchema,
  SUBWORKFLOW_END_TYPE,
  SUBWORKFLOW_START_TYPE,
  shortId,
  WorkflowGraphInputSchema,
  WorkflowGraphSchema,
} from '../index.ts';

describe('workflow graph format', () => {
  it('parses a minimal main workflow graph', () => {
    expect(WorkflowGraphSchema.safeParse(emptyGraph('workflow')).success).toBe(true);
  });
  it('emptyGraph("subworkflow") has a start, an end and one edge between them', () => {
    const g = emptyGraph('subworkflow');
    expect(g.nodes.map((n) => n.type)).toEqual([SUBWORKFLOW_START_TYPE, SUBWORKFLOW_END_TYPE]);
    expect(g.edges).toEqual([
      { id: 'start-end', from: { node: 'start', port: 'file' }, to: { node: 'end', port: 'file' } },
    ]);
  });
  it('rejects duplicate node ids, bad type names and formatVersion 1', () => {
    const g = emptyGraph('workflow');
    const n = {
      id: 'a',
      type: 'core:input-manual',
      typeVersion: 1,
      settings: {},
      position: { x: 0, y: 0 },
    };
    expect(WorkflowGraphSchema.safeParse({ ...g, nodes: [n, n] }).success).toBe(false);
    expect(
      WorkflowGraphSchema.safeParse({ ...g, nodes: [{ ...n, type: 'no-namespace' }] }).success,
    ).toBe(false);
    expect(WorkflowGraphSchema.safeParse({ ...g, formatVersion: 1 }).success).toBe(false);
  });
  it('emptyGraph is format 2; the input schema accepts format 1 and 2, nothing else', () => {
    const g = emptyGraph('workflow');
    expect(g.formatVersion).toBe(2);
    expect(emptyGraph('subworkflow').formatVersion).toBe(2);
    expect(WorkflowGraphInputSchema.safeParse(g).success).toBe(true);
    expect(WorkflowGraphInputSchema.safeParse({ ...g, formatVersion: 1 }).success).toBe(true);
    expect(WorkflowGraphInputSchema.safeParse({ ...g, formatVersion: 3 }).success).toBe(false);
  });
  it('accepts any JSON as settings (content is validated later)', () => {
    const n = { id: 'a', type: 'core:x', typeVersion: 1, settings: 5, position: { x: 0, y: 0 } };
    expect(WorkflowGraphSchema.safeParse({ ...emptyGraph('workflow'), nodes: [n] }).success).toBe(
      true,
    );
  });
  it('caps the graph at 500 nodes, 2000 edges and 100 groups', () => {
    const g = emptyGraph('workflow');
    const nodes = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `n${i}`,
        type: 'core:x',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      }));
    const edges = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `e${i}`,
        from: { node: 'a', port: 'file' },
        to: { node: 'b', port: 'file' },
      }));
    const groups = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `g${i}`,
        name: 'G',
        collapsed: false,
        position: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
      }));
    const message = (input: unknown) =>
      WorkflowGraphSchema.safeParse(input).error?.issues.map((i) => i.message);
    expect(WorkflowGraphSchema.safeParse({ ...g, nodes: nodes(500) }).success).toBe(true);
    expect(message({ ...g, nodes: nodes(501) })).toEqual(['A workflow can have at most 500 nodes']);
    expect(WorkflowGraphSchema.safeParse({ ...g, edges: edges(2000) }).success).toBe(true);
    expect(message({ ...g, edges: edges(2001) })).toEqual([
      'A workflow can have at most 2000 edges',
    ]);
    expect(WorkflowGraphSchema.safeParse({ ...g, groups: groups(100) }).success).toBe(true);
    expect(message({ ...g, groups: groups(101) })).toEqual([
      'A workflow can have at most 100 groups',
    ]);
  });
  it('RunSubworkflowSettingsSchema defaults overrides to {} and labels every field', () => {
    expect(RunSubworkflowSettingsSchema.parse({ subworkflowId: 'w', version: 1 })).toEqual({
      subworkflowId: 'w',
      version: 1,
      overrides: {},
    });
    const props = (
      z.toJSONSchema(RunSubworkflowSettingsSchema, { io: 'input' }) as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    for (const k of ['subworkflowId', 'version', 'overrides']) {
      expect(props[k]?.description).toEqual(expect.any(String));
    }
  });
  it('shortId is 10 chars of [A-Za-z0-9_-] and unique across 1000 draws', () => {
    const ids = new Set(Array.from({ length: 1000 }, shortId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });
  it('hasErrors ignores warnings', () => {
    expect(hasErrors([{ severity: 'warning', code: 'NODE_UNREACHABLE', message: 'm' }])).toBe(
      false,
    );
    expect(hasErrors([{ severity: 'error', code: 'GRAPH_CYCLE', message: 'm' }])).toBe(true);
  });
});
