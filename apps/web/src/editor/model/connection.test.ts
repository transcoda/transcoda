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
    formatVersion: 1,
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
