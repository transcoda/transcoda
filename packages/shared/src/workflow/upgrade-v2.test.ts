import { describe, expect, it } from 'vitest';
import { RENDER_TYPE, upgradeGraphJson, WorkflowGraphSchema } from '../index.ts';

const FINISH = new Set([
  'core:replace-original',
  'core:move-copy',
  'core:size-gate',
  'core:notify-webhook',
  RENDER_TYPE,
]);
const isFinish = (t: string) => FINISH.has(t);

type RawNode = {
  id: string;
  type: string;
  typeVersion: number;
  settings: unknown;
  position: { x: number; y: number };
  groupId?: string;
};
type RawEdge = {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
};
type RawGraph = {
  formatVersion: number;
  kind: string;
  nodes: RawNode[];
  edges: RawEdge[];
  groups: unknown[];
};

function n(id: string, type: string, x = 0, y = 0, extra: Partial<RawNode> = {}): RawNode {
  return { id, type, typeVersion: 1, settings: {}, position: { x, y }, ...extra };
}
function e(id: string, from: string, to: string, fromPort = 'file'): RawEdge {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: 'file' } };
}
function v1(nodes: RawNode[], edges: RawEdge[], kind = 'workflow'): RawGraph {
  return { formatVersion: 1, kind, nodes, edges, groups: [] };
}
const up = (g: unknown) => upgradeGraphJson(g, isFinish) as RawGraph;

describe('upgradeGraphJson (graph format 1 → 2)', () => {
  it('inserts one Render between an action output and the finish nodes it feeds; the fan-out moves to Done', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual', 0, 0),
          n('enc', 'core:encode-video', 200, 40),
          n('replace', 'core:replace-original', 600, 40),
          n('notify', 'core:notify-webhook', 800, 200),
        ],
        [
          e('in-enc', 'in', 'enc'),
          e('enc-replace', 'enc', 'replace'),
          e('enc-notify', 'enc', 'notify'),
        ],
      ),
    );
    expect(g.formatVersion).toBe(2);
    const render = g.nodes.find((x) => x.type === RENDER_TYPE);
    expect(render).toEqual({
      id: 'render-1',
      type: RENDER_TYPE,
      typeVersion: 1,
      settings: {},
      position: { x: 400, y: 40 },
    });
    expect(g.edges).toEqual([
      e('in-enc', 'in', 'enc'),
      e('render-1-in', 'enc', 'render-1'),
      e('enc-replace', 'render-1', 'replace', 'done'),
      e('enc-notify', 'render-1', 'notify', 'done'),
    ]);
    expect(WorkflowGraphSchema.safeParse(g).success).toBe(true);
  });

  it('covers trigger→finish and condition→finish edges, one Render per output', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual'),
          n('cond', 'core:video-is', 200),
          n('replace', 'core:replace-original', 400),
          n('move', 'core:move-copy', 400, 200),
        ],
        [
          e('in-cond', 'in', 'cond'),
          e('cond-replace', 'cond', 'replace', 'pass'),
          e('cond-move', 'cond', 'move', 'else'),
        ],
      ),
    );
    const renders = g.nodes.filter((x) => x.type === RENDER_TYPE).map((x) => x.id);
    expect(renders).toEqual(['render-1', 'render-2']);
    expect(g.edges).toContainEqual(e('render-1-in', 'cond', 'render-1', 'pass'));
    expect(g.edges).toContainEqual(e('cond-replace', 'render-1', 'replace', 'done'));
    expect(g.edges).toContainEqual(e('render-2-in', 'cond', 'render-2', 'else'));
    expect(g.edges).toContainEqual(e('cond-move', 'render-2', 'move', 'done'));

    const trig = up(
      v1(
        [n('in', 'core:input-manual'), n('replace', 'core:replace-original', 400)],
        [e('x', 'in', 'replace')],
      ),
    );
    expect(trig.nodes.map((x) => x.id)).toEqual(['in', 'replace', 'render-1']);
    expect(trig.edges).toEqual([
      e('render-1-in', 'in', 'render-1'),
      e('x', 'render-1', 'replace', 'done'),
    ]);
  });

  it('leaves finish→finish edges alone (replace→notify), sub-workflow graphs untouched but at v2, and v2 input untouched', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual'),
          n('replace', 'core:replace-original', 400),
          n('notify', 'core:notify-webhook', 600),
        ],
        [e('a', 'in', 'replace'), e('b', 'replace', 'notify')],
      ),
    );
    expect(g.nodes.filter((x) => x.type === RENDER_TYPE)).toHaveLength(1);
    expect(g.edges).toContainEqual(e('b', 'replace', 'notify'));

    const sub = v1(
      [n('start', 'core:subworkflow-start'), n('end', 'core:subworkflow-end')],
      [e('s', 'start', 'end')],
      'subworkflow',
    );
    expect(up(sub)).toEqual({ ...sub, formatVersion: 2 });

    const v2 = {
      ...v1(
        [n('in', 'core:input-manual'), n('replace', 'core:replace-original')],
        [e('a', 'in', 'replace')],
      ),
      formatVersion: 2,
    };
    expect(up(v2)).toBe(v2);
    expect(upgradeGraphJson('nonsense', isFinish)).toBe('nonsense');
    expect(upgradeGraphJson(null, isFinish)).toBe(null);
  });

  it('leaves an edge to an unknown type alone (no Render) and keeps the graph parseable', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual'),
          n('enc', 'core:encode-video'),
          n('replace', 'core:replace-original'),
          n('plug', 'x:not-installed'),
        ],
        [e('a', 'in', 'enc'), e('b', 'enc', 'replace'), e('c', 'enc', 'plug')],
      ),
    );
    expect(g.nodes.some((x) => x.type === RENDER_TYPE)).toBe(false);
    expect(g.edges.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(WorkflowGraphSchema.safeParse(g).success).toBe(true);
  });

  it('never puts a Render before an existing Render, and picks free ids', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual'),
          n('render-1', RENDER_TYPE),
          n('replace', 'core:replace-original'),
          n('enc', 'core:encode-video'),
          n('move', 'core:move-copy'),
        ],
        [
          e('a', 'in', 'render-1'),
          e('b', 'render-1', 'replace', 'done'),
          e('c', 'enc', 'move'),
          e('render-2-in', 'x', 'y'),
        ],
      ),
    );
    expect(g.nodes.filter((x) => x.type === RENDER_TYPE).map((x) => x.id)).toEqual([
      'render-1',
      'render-3',
    ]);
    expect(g.edges).toContainEqual(e('render-3-in', 'enc', 'render-3'));
  });

  it('copies the source node groupId when the targets share it', () => {
    const g = up(
      v1(
        [
          n('in', 'core:input-manual'),
          n('enc', 'core:encode-video', 0, 0, { groupId: 'g' }),
          n('replace', 'core:replace-original', 0, 0, { groupId: 'g' }),
          n('enc2', 'core:encode-video', 0, 0, { groupId: 'g' }),
          n('move', 'core:move-copy'),
        ],
        [e('a', 'in', 'enc'), e('b', 'enc', 'replace'), e('c', 'enc2', 'move')],
      ),
    );
    expect(g.nodes.find((x) => x.id === 'render-1')?.groupId).toBe('g');
    expect(g.nodes.find((x) => x.id === 'render-2')).not.toHaveProperty('groupId');
  });
});
