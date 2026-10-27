import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeInfo } from '@transcoda/contract';
import type { FinishPhase, WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../hooks/useCatalog.ts';
import { catalogFixture as catalog, nodesFixture } from '../../test/fixtures/catalog.ts';
import { chainMainReplace, tiggerPoohSub } from '../../test/fixtures/graphs.ts';
import { checkConnection, compatibleTargets, freeOutputs, nextNodeRule } from './connection.ts';

/** A hand-made plugin finish node (the core catalogue has no library-manager or media-server). */
function pluginFinish(type: string, title: string, finishPhase?: FinishPhase): NodeInfo {
  return {
    type,
    version: 1,
    kind: 'finish',
    title,
    description: `${title}.`,
    icon: 'plug',
    inputs: [{ id: 'file', label: 'File', type: 'file' }],
    outputs: [{ id: 'file', label: 'File', type: 'file' }],
    settingsSchema: {},
    onNodeSettings: [],
    source: { kind: 'plugin', name: 'example', version: '1.0.0' },
    availability: { available: true },
    ...(finishPhase !== undefined && { finishPhase }),
  };
}

const phased = buildCatalog([
  ...nodesFixture,
  pluginFinish('example:library', 'Refresh library', 'library-manager'),
  pluginFinish('example:media', 'Rescan media server', 'media-server'),
]);

/** One node of `type` (id `src`), optionally bypassed or renamed. */
function single(type: string, extra: { bypassed?: boolean; label?: string } = {}): WorkflowGraph {
  return {
    formatVersion: 2,
    kind: 'workflow',
    nodes: [{ id: 'src', type, typeVersion: 1, settings: {}, position: { x: 0, y: 0 }, ...extra }],
    edges: [],
    groups: [],
  };
}

const WRITE_AND_LATER = [
  'core:replace-original',
  'core:move-copy',
  'core:notify-webhook',
  'example:library',
  'example:media',
];
const NON_WRITING = ['core:notify-webhook', 'example:library', 'example:media'];

describe('connection rules', () => {
  it('checkConnection accepts a free matching input and names the refusal otherwise', () => {
    const g = chainMainReplace();
    const unwired = { ...g, edges: [] };
    expect(
      checkConnection(
        unwired,
        { node: 'in', port: 'file' },
        { node: 'keep', port: 'file' },
        catalog,
      ),
    ).toEqual({ ok: true });
    expect(
      checkConnection(g, { node: 'in', port: 'file' }, { node: 'keep', port: 'language' }, catalog),
    ).toEqual({ ok: false, reason: "Those ports don't match (file → data:language)" });
    expect(
      checkConnection(g, { node: 'in', port: 'file' }, { node: 'keep', port: 'file' }, catalog),
    ).toEqual({ ok: false, reason: 'That input is already connected' });
    expect(
      checkConnection(g, { node: 'ro', port: 'file' }, { node: 'ro', port: 'file' }, catalog),
    ).toEqual({ ok: false, reason: "A node can't connect to itself" });
    expect(
      checkConnection(g, { node: 'in', port: 'nope' }, { node: 'ro', port: 'file' }, catalog),
    ).toEqual({ ok: false, reason: 'That port does not exist' });
    expect(
      checkConnection(g, { node: 'in', port: 'file' }, { node: 'gone', port: 'file' }, catalog),
    ).toEqual({ ok: false, reason: 'That node no longer exists' });
  });

  it('compatibleTargets for file in a sub-workflow excludes trigger and finish nodes', () => {
    const sub = compatibleTargets(catalog, 'file', 'subworkflow').map((n) => n.type);
    expect(sub).toContain('core:keep-languages');
    expect(sub).toContain('core:video-is');
    expect(sub).toContain('core:subworkflow-end');
    expect(sub).toContain('test:unavailable');
    for (const t of sub) {
      expect(['trigger', 'finish']).not.toContain(catalog.byType.get(t)?.kind);
    }

    const main = compatibleTargets(catalog, 'file', 'workflow').map((n) => n.type);
    expect(main).toContain('core:replace-original');
    expect(main).not.toContain('core:subworkflow-end');
    expect(main).not.toContain('core:input-manual');

    const data = compatibleTargets(catalog, 'data:language', 'workflow').map((n) => n.type);
    expect(data.sort()).toEqual([
      'core:has-stream',
      'core:keep-languages',
      'core:set-default-track',
    ]);
  });

  it.each([
    ['core:replace-original', 'file', WRITE_AND_LATER, false],
    ['core:move-copy', 'file', WRITE_AND_LATER, false],
    ['core:size-gate', 'pass', WRITE_AND_LATER, false],
    ['core:size-gate', 'else', NON_WRITING, true],
    ['example:library', 'file', NON_WRITING, false],
    ['example:media', 'file', ['core:notify-webhook', 'example:media'], false],
    ['core:notify-webhook', 'file', ['core:notify-webhook'], false],
  ])(
    'after %s (%s) the "+" search lists only finish nodes the validator accepts there',
    (type, port, expected, noWrite) => {
      const rule = nextNodeRule(single(type), 'src', port, phased);
      expect(rule).toMatchObject({ kind: 'finish-after', noWrite });
      const listed = compatibleTargets(phased, 'file', 'workflow', rule);
      expect(listed.map((n) => n.type).sort()).toEqual([...expected].sort());
      // Review Focus 3: never a condition or an action after a finish node.
      for (const n of listed) expect(n.kind).toBe('finish');
    },
  );

  it('nextNodeRule names the node as shown and maps phases to ranks', () => {
    expect(nextNodeRule(single('core:replace-original'), 'src', 'file', phased)).toEqual({
      kind: 'finish-after',
      minRank: 2,
      noWrite: false,
      afterTitle: 'Replace original',
    });
    expect(
      nextNodeRule(single('core:size-gate', { label: 'Big files' }), 'src', 'else', phased),
    ).toEqual({ kind: 'finish-after', minRank: 3, noWrite: true, afterTitle: 'Big files' });
  });

  it("after the size gate's No a finish node with no declared phase is not offered", () => {
    const loose = buildCatalog([...phased.nodes, pluginFinish('example:loose', 'Loose')]);
    const rule = nextNodeRule(single('core:size-gate'), 'src', 'else', loose);
    const listed = compatibleTargets(loose, 'file', 'workflow', rule).map((n) => n.type);
    expect(listed).not.toContain('example:loose');
    expect(listed.sort()).toEqual([...NON_WRITING].sort());
  });

  it('replace-original lists no condition and no action ("Video is", "Encode video")', () => {
    const rule = nextNodeRule(single('core:replace-original'), 'src', 'file', catalog);
    const listed = compatibleTargets(catalog, 'file', 'workflow', rule).map((n) => n.type);
    expect(listed).not.toContain('core:video-is');
    expect(listed).not.toContain('core:encode-video');
    expect(listed).toContain('core:notify-webhook');
  });

  it('a finish node with no declared phase is followed by finish nodes of any phase', () => {
    const loose = buildCatalog([...phased.nodes, pluginFinish('example:loose', 'Loose')]);
    const rule = nextNodeRule(single('example:loose'), 'src', 'file', loose);
    expect(rule).toMatchObject({ kind: 'finish-after', minRank: 0, noWrite: false });
    const listed = compatibleTargets(loose, 'file', 'workflow', rule).map((n) => n.type);
    expect(listed.sort()).toEqual(['core:size-gate', ...WRITE_AND_LATER, 'example:loose'].sort());
    // ... and a phase-less finish node may follow any finish node.
    const after = nextNodeRule(single('core:notify-webhook'), 'src', 'file', loose);
    expect(
      compatibleTargets(loose, 'file', 'workflow', after)
        .map((n) => n.type)
        .sort(),
    ).toEqual(['core:notify-webhook', 'example:loose'].sort());
  });

  it('a non-finish, bypassed or unknown source lists exactly what it lists today', () => {
    const today = compatibleTargets(phased, 'file', 'workflow').map((n) => n.type);
    for (const [g, port] of [
      [single('core:video-is'), 'pass'],
      [single('core:encode-video'), 'file'],
      [single('core:replace-original', { bypassed: true }), 'file'],
      [single('core:nope'), 'file'],
    ] as const) {
      const rule = nextNodeRule(g, 'src', port, phased);
      expect(rule).toEqual({ kind: 'any' });
      expect(compatibleTargets(phased, 'file', 'workflow', rule).map((n) => n.type)).toEqual(today);
    }
    expect(nextNodeRule(single('core:video-is'), 'gone', 'pass', phased)).toEqual({ kind: 'any' });
  });

  describe('Damaged outputs', () => {
    const replaceDamaged: NodeInfo = {
      ...pluginFinish('example:replace-damaged', 'Replace damaged file', 'library-manager'),
      outputs: [],
      damagedOnly: true,
    };
    const damagedCatalog = buildCatalog([...phased.nodes, replaceDamaged]);
    const at = (id: string, type: string, settings: Record<string, unknown> = {}) => ({
      id,
      type,
      typeVersion: 1,
      settings: settings as WorkflowGraph['nodes'][number]['settings'],
      position: { x: 0, y: 0 },
    });
    /** in → ev → Render r (Quality check as given) → Done → ro; cs (Check source); nw, rd free. */
    const graph = (qualityCheck: boolean): WorkflowGraph => ({
      formatVersion: 2,
      kind: 'workflow',
      nodes: [
        at('in', 'core:input-manual'),
        at('cs', 'core:check-source'),
        at('ev', 'core:encode-video'),
        at('r', 'core:render', { qualityCheck }),
        at('ro', 'core:replace-original'),
        at('nw', 'core:notify-webhook'),
        at('nw2', 'core:notify-webhook'),
        at('rd', 'example:replace-damaged'),
      ],
      edges: [
        { id: 'e1', from: { node: 'in', port: 'file' }, to: { node: 'cs', port: 'file' } },
        { id: 'e2', from: { node: 'cs', port: 'ok' }, to: { node: 'ev', port: 'file' } },
        { id: 'e3', from: { node: 'ev', port: 'file' }, to: { node: 'r', port: 'file' } },
        { id: 'e4', from: { node: 'r', port: 'done' }, to: { node: 'ro', port: 'file' } },
      ],
      groups: [],
    });
    const withEdge = (g: WorkflowGraph, from: [string, string], to: string): WorkflowGraph => ({
      ...g,
      edges: [
        ...g.edges,
        { id: 'x', from: { node: from[0], port: from[1] }, to: { node: to, port: 'file' } },
      ],
    });
    const check = (g: WorkflowGraph, from: [string, string], to: string) =>
      checkConnection(
        g,
        { node: from[0], port: from[1] },
        { node: to, port: 'file' },
        damagedCatalog,
      );

    it('refuses a connection from a hidden Damaged output', () => {
      expect(check(graph(false), ['r', 'damaged'], 'nw')).toEqual({
        ok: false,
        reason: 'That output is only there while Quality check is on',
      });
      expect(check(graph(true), ['r', 'damaged'], 'nw')).toEqual({ ok: true });
      expect(freeOutputs(graph(false), 'r', damagedCatalog).map((p) => p.id)).toEqual([]);
      expect(freeOutputs(graph(true), 'r', damagedCatalog).map((p) => p.id)).toEqual(['damaged']);
    });

    it('a damagedOnly node connects only from Render’s or Check source’s Damaged, or after a notify on that side', () => {
      const refused = {
        ok: false,
        reason: 'Replace damaged file can only follow a Damaged output',
      };
      expect(check(graph(true), ['r', 'damaged'], 'rd')).toEqual({ ok: true });
      expect(check(graph(true), ['cs', 'damaged'], 'rd')).toEqual({ ok: true });
      expect(check(graph(true), ['ro', 'file'], 'rd')).toEqual(refused);
      expect(check(graph(true), ['cs', 'ok'], 'rd')).toEqual(refused);
      // After a notify on the Damaged side.
      const viaNotify = withEdge(graph(true), ['r', 'damaged'], 'nw');
      expect(check(viaNotify, ['nw', 'file'], 'rd')).toEqual({ ok: true });
      const sourceNotify = withEdge(graph(true), ['cs', 'damaged'], 'nw2');
      expect(check(sourceNotify, ['nw2', 'file'], 'rd')).toEqual({ ok: true });
      // A notify after Done is not on a Damaged side.
      const afterDone = withEdge(graph(true), ['ro', 'file'], 'nw');
      expect(check(afterDone, ['nw', 'file'], 'rd')).toEqual(refused);
    });

    it('nextNodeRule after Damaged allows non-writing phases and damagedOnly nodes; after Done the gate phase and later, no damagedOnly', () => {
      const listed = (g: WorkflowGraph, id: string, port: string) =>
        compatibleTargets(
          damagedCatalog,
          'file',
          'workflow',
          nextNodeRule(g, id, port, damagedCatalog),
        )
          .map((n) => n.type)
          .sort();
      const damaged = [...NON_WRITING, 'example:replace-damaged'].sort();
      expect(nextNodeRule(graph(true), 'r', 'damaged', damagedCatalog)).toEqual({
        kind: 'finish-after',
        minRank: 3,
        noWrite: true,
        afterTitle: 'Render',
        damaged: true,
      });
      expect(listed(graph(true), 'r', 'damaged')).toEqual(damaged);
      expect(listed(graph(true), 'cs', 'damaged')).toEqual(damaged);
      const viaNotify = withEdge(graph(true), ['r', 'damaged'], 'nw');
      expect(listed(viaNotify, 'nw', 'file')).toEqual(['core:notify-webhook']);
      expect(nextNodeRule(graph(true), 'r', 'done', damagedCatalog)).toEqual({
        kind: 'finish-after',
        minRank: 1,
        noWrite: false,
        afterTitle: 'Render',
      });
      expect(listed(graph(true), 'r', 'done')).toEqual(
        ['core:size-gate', ...WRITE_AND_LATER].sort(),
      );
      // After Check source's OK anything goes, except a damagedOnly node.
      expect(listed(graph(true), 'cs', 'ok')).not.toContain('example:replace-damaged');
      expect(listed(graph(true), 'cs', 'ok')).toContain('core:encode-video');
    });
  });

  it('freeOutputs lists the outputs without an edge', () => {
    const sub = tiggerPoohSub();
    expect(freeOutputs(sub, 'rt', catalog)).toEqual([]);
    expect(freeOutputs({ ...sub, edges: [] }, 'rt', catalog).map((p) => p.id)).toEqual(['file']);
    const g = chainMainReplace();
    expect(freeOutputs(g, 'ro', catalog).map((p) => p.id)).toEqual(['file']);
    expect(freeOutputs(g, 'gone', catalog)).toEqual([]);
  });

  it('no module under editor/model imports @xyflow', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(files).toContain('graph-ops.ts');
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/['"]@xyflow/);
    }
  });
});
