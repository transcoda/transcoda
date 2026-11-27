import { defineNode } from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getSetting } from '../db/repos/settings.ts';
import { filePort } from '../nodes/core/common.ts';
import { CorruptGraphError } from './service.ts';
import {
  bumpNoPath,
  bumpThrowing,
  bumpV2,
  bumpV3,
  chain,
  childGraph,
  node,
} from './test-helpers.ts';
import {
  activate,
  codes,
  corrupt,
  current,
  db,
  log,
  mainWith,
  make,
  NOW,
  otherDef,
  run,
  summary,
  svc,
  svcWith,
  useServiceDb,
} from './testing.ts';

useServiceDb();

describe('WorkflowService', () => {
  it('upgradeAll: safe bump → new version with note "Updated Bump 1→2", active_version untouched, summary { upgraded: 1, behaviour: 0, broken: 0, unchanged: N }', () => {
    const w = make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(w, 2);
    make('Sub', 'subworkflow', childGraph());
    make('Plain', 'workflow', mainWith());

    const after = svcWith(bumpV2());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 0, broken: 0, unchanged: 2 });
    const detail = after.get(w);
    expect(detail).toMatchObject({
      currentVersion: 3,
      active: { version: 2, runnable: true },
    });
    expect(detail?.graph.nodes.find((n) => n.id === 'b')).toMatchObject({
      typeVersion: 2,
      settings: { level: 1, label: '' },
    });
    expect(after.versions(w)?.[0]).toEqual({
      version: 3,
      note: 'Updated Bump 1→2',
      createdBy: 'system:upgrade',
      createdAt: NOW.toISOString(),
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'workflow upgrades: 1 upgraded (0 with behavior changes), 0 broken, 2 unchanged',
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 0, unchanged: 3 });
    expect(getSetting(db, 'workflow_review_acks', z.unknown())).toBeNull();
  });

  it('upgradeAll: behaviour bump → new version whose note carries the migration note, behaviour counted, active untouched and no longer runnable', () => {
    const on = make('Enabled', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(on, 2);
    const dry = make('Dry', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));

    const after = svcWith(bumpV3());
    expect(after.upgradeAll()).toEqual({ upgraded: 2, behaviour: 2, broken: 0, unchanged: 0 });
    const onDetail = after.get(on);
    expect(onDetail).toMatchObject({ currentVersion: 3, active: { version: 2, runnable: false } });
    expect(onDetail?.graph.nodes.find((n) => n.id === 'b')?.settings).toEqual({
      level: 1,
      label: '',
      strict: true,
    });
    expect(after.get(dry)).toMatchObject({ currentVersion: 3, active: null });
    expect(after.versions(on)?.[0]?.note).toBe('Updated Bump 1→3 (strict mode on by default)');
  });

  it('upgradeAll: no path → nothing written, broken 1; throwing migration → broken 1, logged once, other workflows still upgraded; corrupt graph → broken 1; exactly one info line', () => {
    // 'A mixed' has a bump node (no path) and an 'other' node (has a path): nothing is rewritten
    const mixed = make(
      'A mixed',
      'workflow',
      mainWith(node('b', 'test:bump', { level: 1 }), node('o', 'test:other', { n: 1 })),
    );
    const other = make('B other', 'workflow', mainWith(node('o', 'test:other', { n: 1 })));
    const broken = make('C corrupt', 'workflow', mainWith());
    corrupt(broken);

    expect(svcWith(bumpNoPath(), otherDef(2)).upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 0,
      broken: 2,
      unchanged: 0,
    });
    expect(current(mixed)).toBe(2);
    expect(svc.get(mixed)?.graph.nodes.find((n) => n.id === 'o')?.typeVersion).toBe(1);
    expect(current(other)).toBe(3);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      'workflow upgrades: 1 upgraded (0 with behavior changes), 2 broken, 0 unchanged',
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade skipped: no migration path',
      workflowId: mixed,
      nodeIds: ['b'],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'workflow upgrade skipped: corrupt graph',
        workflowId: broken,
        version: 2,
        error: expect.any(String),
      }),
    );

    vi.clearAllMocks();
    const late = make('D other', 'workflow', mainWith(node('o', 'test:other', { n: 2 })));
    expect(svcWith(bumpThrowing(), otherDef(2)).upgradeAll()).toEqual({
      upgraded: 1,
      behaviour: 0,
      broken: 2,
      unchanged: 1,
    });
    expect(current(mixed)).toBe(2);
    expect(current(late)).toBe(3);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade failed',
      workflowId: mixed,
      error: 'boom',
    });
  });

  it('upgradeAll upgrades a sub-workflow without touching its parents (parent then usesOutdatedSubworkflow)', () => {
    const sub = make('Sub', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', sub, 2)));
    expect(summary(parent).usesOutdatedSubworkflow).toBe(false);

    const after = svcWith(bumpV2());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 0, broken: 0, unchanged: 1 });
    expect(after.get(sub)?.currentVersion).toBe(3);
    const p = after.get(parent);
    expect(p).toMatchObject({ currentVersion: 2, usesOutdatedSubworkflow: true });
    expect(p?.graph.nodes.find((n) => n.id === 'run')?.settings).toMatchObject({ version: 2 });
  });

  it('upgradeAll: a migration output that does not parse as a graph → broken 1, warned once, nothing written, active unchanged', () => {
    const w = make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    activate(w, 2);
    const forgetful = defineNode({
      type: 'test:bump',
      version: 2,
      kind: 'action',
      title: 'Bump',
      description: 'Migration mutates and forgets to return.',
      icon: 'test',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({ level: z.number().default(1).describe('Level') }),
      migrations: [
        {
          from: 1,
          to: 2,
          risk: 'safe',
          note: 'label added',
          migrate: ((s: Record<string, JsonValue>) => {
            s.label = '';
          }) as unknown as (s: JsonValue) => JsonValue,
        },
      ],
    });
    const after = svcWith(forgetful);
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 1, unchanged: 0 });
    expect(current(w)).toBe(2);
    expect(summary(w).active).toMatchObject({ version: 2, runnable: true });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({
      msg: 'workflow upgrade failed',
      workflowId: w,
      error: expect.any(String),
    });
  });

  it('upgradeAll: a database failure while listing logs one error and returns the empty summary', () => {
    make('Bumpy', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const after = svcWith(bumpV2());
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(after.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 0, unchanged: 0 });
    vi.restoreAllMocks();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith({
      msg: 'workflow upgrades failed: could not list workflows',
      error: 'disk I/O error',
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('upgradeAll: a live workflow whose current version row is missing counts as broken; list shows it invalid', () => {
    const w = make('Gone', 'workflow', mainWith());
    make('Plain', 'workflow', mainWith());
    db.prepare('UPDATE workflows SET current_version = 9 WHERE id = ?').run(w);
    expect(svc.upgradeAll()).toEqual({ upgraded: 0, behaviour: 0, broken: 1, unchanged: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'workflow upgrade skipped: corrupt graph',
        workflowId: w,
        version: 9,
        error: 'Stored version 9 is missing',
      }),
    );
    expect(summary(w)).toMatchObject({ valid: false, errorCount: 1, currentVersion: 9 });
    expect(() => svc.get(w)).toThrow(CorruptGraphError);
  });

  it('upgradeAll: a no-path or corrupt active workflow keeps its active version', () => {
    const noPath = make('No path', 'workflow', mainWith(node('b', 'test:bump', { level: 1 })));
    const broken = make('Corrupt', 'workflow', mainWith());
    activate(noPath, 2);
    activate(broken, 2);
    corrupt(broken);
    expect(svcWith(bumpNoPath()).upgradeAll()).toEqual({
      upgraded: 0,
      behaviour: 0,
      broken: 2,
      unchanged: 0,
    });
    expect(summary(noPath)).toMatchObject({ currentVersion: 2, active: { version: 2 } });
    expect(summary(broken)).toMatchObject({
      currentVersion: 2,
      active: { version: 2, runnable: false },
    });
  });

  it('upgradeAll: a behaviour upgrade of a sub-workflow writes no parent version and moves no active pointer; the parent pinning the old version just cannot run', () => {
    const sub = make('Strict sub', 'subworkflow', chain('subworkflow', node('b', 'test:bump')));
    const parent = make('Parent', 'workflow', mainWith(run('run', sub, 2)));
    activate(parent);
    const other = make('Other', 'workflow', mainWith());
    activate(other);

    const after = svcWith(bumpV3());
    expect(after.upgradeAll()).toEqual({ upgraded: 1, behaviour: 1, broken: 0, unchanged: 2 });
    expect(after.get(sub)).toMatchObject({ currentVersion: 3, active: null });
    const p = after.get(parent);
    expect(p).toMatchObject({ currentVersion: 2, active: { version: 2, runnable: false } });
    expect(after.versions(parent)).toHaveLength(2);
    expect(codes(p?.activeIssues ?? [])).toContain('error:SUBWORKFLOW_BROKEN');
    expect(after.get(other)?.active).toMatchObject({ version: 2, runnable: true });
  });
});
