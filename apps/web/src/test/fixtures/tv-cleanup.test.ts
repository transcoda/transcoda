import { RUN_SUBWORKFLOW_TYPE, WorkflowGraphSchema } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { TV_CLEANUP_NAME, TV_CLEANUP_SUB_NAME, tvCleanupMain, tvCleanupSub } from './tv-cleanup.ts';

const runNodes = (subId: string, version: number) =>
  tvCleanupMain(subId, version).nodes.filter((n) => n.type === RUN_SUBWORKFLOW_TYPE);

describe('TV cleanup example', () => {
  it('both example graphs parse under WorkflowGraphSchema and the main pins both Run nodes to the given sub id/version', () => {
    expect(TV_CLEANUP_NAME).toBe('TV cleanup');
    expect(TV_CLEANUP_SUB_NAME).toBe('Language cleanup');
    expect(WorkflowGraphSchema.safeParse(tvCleanupSub()).success).toBe(true);
    expect(WorkflowGraphSchema.safeParse(tvCleanupMain('__sub__', 0)).success).toBe(true);
    expect(WorkflowGraphSchema.safeParse(tvCleanupMain('s1', 2)).success).toBe(true);

    const runs = runNodes('s1', 2);
    expect(runs.map((n) => n.id)).toEqual(['run-a', 'run-b']);
    for (const run of runs) {
      expect(run.settings).toMatchObject({ subworkflowId: 's1', version: 2 });
    }
  });

  it('lays the sub-workflow out left to right with the fixture settings', () => {
    const sub = tvCleanupSub();
    expect(sub.kind).toBe('subworkflow');
    expect(sub.nodes.map((n) => [n.id, n.position])).toEqual([
      ['start', { x: 0, y: 0 }],
      ['keep', { x: 300, y: 0 }],
      ['sdt', { x: 600, y: 0 }],
      ['rt', { x: 900, y: 0 }],
      ['end', { x: 1200, y: 0 }],
    ]);
    const settings = Object.fromEntries(sub.nodes.map((n) => [n.id, n.settings]));
    expect(settings.keep).toEqual({
      languages: ['en', 'de'],
      keepOriginal: true,
      keepUntagged: true,
    });
    expect(settings.sdt).toEqual({ audioLanguages: ['en'], subtitleLanguages: [] });
    expect(settings.rt).toEqual({ languages: ['en', 'de'] });
    expect(sub.edges.map((e) => `${e.from.node}>${e.to.node}`)).toEqual([
      'start>keep',
      'keep>sdt',
      'sdt>rt',
      'rt>end',
    ]);
  });

  it('the example main workflow has the Cleanup group containing run-a and run-b and the tr override on both', () => {
    const main = tvCleanupMain('s1', 2);
    expect(main.kind).toBe('workflow');
    expect(main.groups).toHaveLength(1);
    const [group] = main.groups;
    expect(group?.name).toBe('Cleanup');
    expect(group?.collapsed).toBe(false);
    const members = main.nodes.filter((n) => n.groupId === group?.id).map((n) => n.id);
    expect(members).toEqual(['run-a', 'run-b']);
    for (const run of runNodes('s1', 2)) {
      expect(run.settings).toEqual({
        subworkflowId: 's1',
        version: 2,
        overrides: { 'keep.languages': ['en', 'de', 'tr'] },
      });
      // The group box surrounds each member card.
      const { position: g, size } = group ?? {
        position: { x: 0, y: 0 },
        size: { width: 0, height: 0 },
      };
      expect(run.position.x).toBeGreaterThan(g.x);
      expect(run.position.y).toBeGreaterThan(g.y);
      expect(run.position.x + 210).toBeLessThan(g.x + size.width);
      expect(run.position.y + 120).toBeLessThan(g.y + size.height);
    }
    // No two cards share a position.
    const spots = new Set(main.nodes.map((n) => `${n.position.x},${n.position.y}`));
    expect(spots.size).toBe(main.nodes.length);
    expect(main.nodes.find((n) => n.id === 'in')?.type).toBe('core:input-manual');
    expect(main.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}`)).toEqual([
      'in.file>vi',
      'vi.pass>run-a',
      'run-a.file>ca',
      'ca.file>sg',
      'sg.pass>ro-a',
      'vi.else>ev',
      'ev.file>run-b',
      'run-b.file>ro-b',
    ]);
  });

  it('each call returns a fresh graph (callers may edit it)', () => {
    const a = tvCleanupMain('s1', 2);
    const b = tvCleanupMain('s1', 2);
    expect(a).toEqual(b);
    expect(a.nodes[0]).not.toBe(b.nodes[0]);
  });
});
