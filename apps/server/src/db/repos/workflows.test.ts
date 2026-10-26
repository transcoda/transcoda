import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../open.ts';
import { createTestDb } from '../test-db.ts';
import {
  appendVersion,
  clearActiveVersion,
  findFeeder,
  findVersion,
  findWorkflow,
  insertWorkflow,
  listCurrentVersions,
  listInactiveNamers,
  listVersions,
  listWorkflows,
  NotFoundError,
  renameWorkflow,
  setActiveVersion,
  softDeleteWorkflow,
  VersionConflictError,
} from './workflows.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');
const graph = emptyGraph('workflow');

describe('workflow repository', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    insertWorkflow(
      db,
      {
        id: 'w1',
        kind: 'subworkflow',
        name: 'Sub',
        graph: emptyGraph('subworkflow'),
        createdBy: 'u1',
      },
      now,
    );
  });
  afterEach(() => {
    db.close();
  });

  it('insertWorkflow creates version 1, not active; findVersion returns the parsed graph', () => {
    expect(findWorkflow(db, 'w1')).toMatchObject({
      kind: 'subworkflow',
      currentVersion: 1,
      activeVersion: null,
      activatedAt: null,
      activatedBy: null,
      deletedAt: null,
    });
    expect(findVersion(db, 'w1', 1)).toMatchObject({
      ok: true,
      row: { graph: emptyGraph('subworkflow'), createdBy: 'u1', formatVersion: 1 },
    });
    expect(findVersion(db, 'w1', 2)).toBeNull();
  });

  it('appendVersion is compare-and-insert and reports the current version on conflict', () => {
    const v2 = appendVersion(
      db,
      { workflowId: 'w1', baseVersion: 1, graph, note: null, createdBy: 'u1' },
      later,
    );
    expect(v2.version).toBe(2);
    const attempt = () =>
      appendVersion(
        db,
        { workflowId: 'w1', baseVersion: 1, graph, note: null, createdBy: 'u1' },
        later,
      );
    expect(attempt).toThrow(VersionConflictError);
    expect(attempt).toThrow(expect.objectContaining({ currentVersion: 2 }));
    expect(findWorkflow(db, 'w1')).toMatchObject({
      currentVersion: 2,
      updatedAt: later.toISOString(),
    });
    expect(() =>
      appendVersion(
        db,
        { workflowId: 'nope', baseVersion: 1, graph, note: null, createdBy: 'u1' },
        later,
      ),
    ).toThrow(NotFoundError);
  });

  it('appendVersion records the version and its author and moves current_version and updated_at only', () => {
    appendVersion(
      db,
      {
        workflowId: 'w1',
        baseVersion: 1,
        graph,
        note: 'Updated X 1→2',
        createdBy: 'system:upgrade',
      },
      later,
    );
    expect(findWorkflow(db, 'w1')).toMatchObject({
      currentVersion: 2,
      activeVersion: null,
      updatedAt: later.toISOString(),
    });
    expect(listVersions(db, 'w1')).toEqual([
      {
        workflowId: 'w1',
        version: 2,
        note: 'Updated X 1→2',
        createdBy: 'system:upgrade',
        createdAt: later.toISOString(),
      },
      { workflowId: 'w1', version: 1, note: null, createdBy: 'u1', createdAt: now.toISOString() },
    ]);
  });

  it('a corrupt stored graph is reported, not thrown', () => {
    db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 1').run(
      '{"nope":true}',
      'w1',
    );
    expect(findVersion(db, 'w1', 1)).toMatchObject({
      ok: false,
      workflowId: 'w1',
      version: 1,
      error: expect.any(String),
    });
    expect(listCurrentVersions(db)[0]?.version).toMatchObject({ ok: false, raw: '{"nope":true}' });
    db.prepare('UPDATE workflows SET current_version = 7 WHERE id = ?').run('w1');
    expect(listCurrentVersions(db)[0]?.version).toEqual({
      ok: false,
      workflowId: 'w1',
      version: 7,
      error: 'Stored version 7 is missing',
      raw: null,
    });
    db.prepare('UPDATE workflow_versions SET graph = ? WHERE workflow_id = ? AND version = 1').run(
      'not json',
      'w1',
    );
    expect(findVersion(db, 'w1', 1)).toMatchObject({ ok: false });
  });

  it('soft delete hides the workflow from find/list but keeps versions readable; append then fails', () => {
    expect(softDeleteWorkflow(db, 'w1', now)).toBe(true);
    expect(softDeleteWorkflow(db, 'w1', now)).toBe(false);
    expect(softDeleteWorkflow(db, 'unknown', now)).toBe(false);
    expect(findWorkflow(db, 'w1')).toBeNull();
    expect(findWorkflow(db, 'w1', { includeDeleted: true })?.deletedAt).toBe(now.toISOString());
    expect(listWorkflows(db)).toEqual([]);
    expect(listCurrentVersions(db)).toEqual([]);
    expect(findVersion(db, 'w1', 1)?.ok).toBe(true);
    expect(() =>
      appendVersion(
        db,
        { workflowId: 'w1', baseVersion: 1, graph, note: null, createdBy: 'u1' },
        now,
      ),
    ).toThrow(NotFoundError);
  });

  it('listWorkflows sorts by name case-insensitively; rename bumps updated_at and creates no version', () => {
    insertWorkflow(db, { id: 'w2', kind: 'workflow', name: 'alpha', graph, createdBy: 'u1' }, now);
    insertWorkflow(db, { id: 'w3', kind: 'workflow', name: 'Beta', graph, createdBy: 'u1' }, now);
    expect(listWorkflows(db).map((w) => w.name)).toEqual(['alpha', 'Beta', 'Sub']);
    expect(renameWorkflow(db, 'w3', 'Zulu', later)).toBe(true);
    expect(renameWorkflow(db, 'nope', 'x', later)).toBe(false);
    expect(findWorkflow(db, 'w3')).toMatchObject({
      name: 'Zulu',
      updatedAt: later.toISOString(),
      currentVersion: 1,
    });
    expect(listVersions(db, 'w3')).toHaveLength(1);
    expect(listWorkflows(db).map((w) => w.name)).toEqual(['alpha', 'Sub', 'Zulu']);
  });

  it('appendVersion never touches active_version; setActiveVersion/clearActiveVersion are the only writers and leave updated_at alone', () => {
    insertWorkflow(db, { id: 'w2', kind: 'workflow', name: 'Main', graph, createdBy: 'u1' }, now);
    appendVersion(
      db,
      { workflowId: 'w2', baseVersion: 1, graph, note: null, createdBy: 'u1' },
      now,
    );
    const edited = findWorkflow(db, 'w2')?.updatedAt;
    expect(setActiveVersion(db, 'w2', 1, 'u1', later, null)).toBe(true);
    expect(findWorkflow(db, 'w2')).toMatchObject({
      currentVersion: 2,
      activeVersion: 1,
      activatedBy: 'u1',
      activatedAt: later.toISOString(),
      updatedAt: edited,
    });
    appendVersion(
      db,
      { workflowId: 'w2', baseVersion: 2, graph, note: null, createdBy: 'u1' },
      later,
    );
    expect(findWorkflow(db, 'w2')).toMatchObject({ currentVersion: 3, activeVersion: 1 });
    expect(clearActiveVersion(db, 'w2')).toBe(true);
    expect(findWorkflow(db, 'w2')).toMatchObject({
      activeVersion: null,
      activatedAt: null,
      activatedBy: null,
    });
    expect(() => setActiveVersion(db, 'w2', 9, 'u1', later, null)).toThrow(NotFoundError);
    expect(setActiveVersion(db, 'nope', 1, 'u1', later, null)).toBe(false);
    softDeleteWorkflow(db, 'w2', later);
    expect(setActiveVersion(db, 'w2', 1, 'u1', later, null)).toBe(false);
    expect(clearActiveVersion(db, 'w2')).toBe(false);
    expect(clearActiveVersion(db, 'nope')).toBe(false);
  });

  it('setActiveVersion writes the library binding, clearActiveVersion clears it, findFeeder finds the live feeder', () => {
    insertWorkflow(db, { id: 'w2', kind: 'workflow', name: 'Main', graph, createdBy: 'u1' }, now);
    expect(findWorkflow(db, 'w2')?.activeLibraryId).toBeNull();
    expect(findFeeder(db, 'L')).toBeNull();
    expect(setActiveVersion(db, 'w2', 1, 'u1', later, 'L')).toBe(true);
    expect(findWorkflow(db, 'w2')?.activeLibraryId).toBe('L');
    expect(findFeeder(db, 'L')).toEqual({ workflowId: 'w2', name: 'Main', version: 1 });
    // re-pointing without a library clears the binding
    expect(setActiveVersion(db, 'w2', 1, 'u1', later, null)).toBe(true);
    expect(findFeeder(db, 'L')).toBeNull();
    setActiveVersion(db, 'w2', 1, 'u1', later, 'L');
    expect(clearActiveVersion(db, 'w2')).toBe(true);
    expect(findWorkflow(db, 'w2')?.activeLibraryId).toBeNull();
    expect(findFeeder(db, 'L')).toBeNull();
    // a second live workflow cannot take the same library
    insertWorkflow(db, { id: 'w3', kind: 'workflow', name: 'Other', graph, createdBy: 'u1' }, now);
    setActiveVersion(db, 'w2', 1, 'u1', later, 'L');
    expect(() => setActiveVersion(db, 'w3', 1, 'u1', later, 'L')).toThrow(/UNIQUE/);
    expect(findWorkflow(db, 'w3')?.activeVersion).toBeNull();
    // a soft-deleted feeder is no feeder
    softDeleteWorkflow(db, 'w2', later);
    expect(findFeeder(db, 'L')).toBeNull();
    expect(setActiveVersion(db, 'w3', 1, 'u1', later, 'L')).toBe(true);
    expect(findFeeder(db, 'L')).toEqual({ workflowId: 'w3', name: 'Other', version: 1 });
  });

  it('listInactiveNamers: per library, the live workflows whose newest version names it and is not active, most recently edited first', () => {
    const naming = (libraryId: string) => ({
      ...graph,
      nodes: [
        {
          id: 'in',
          type: 'core:input-library',
          typeVersion: 1,
          settings: { libraryId },
          position: { x: 0, y: 0 },
        },
      ],
    });
    const add = (id: string, name: string, g: typeof graph, at: Date) =>
      insertWorkflow(db, { id, kind: 'workflow', name, graph: g, createdBy: 'u1' }, at);
    expect(listInactiveNamers(db)).toEqual(new Map());
    // v1 has no Library input; v2 (the newest, never activated) names L
    add('a', 'Movie Cleanup', graph, now);
    appendVersion(
      db,
      { workflowId: 'a', baseVersion: 1, graph: naming('L'), note: null, createdBy: 'u1' },
      now,
    );
    add('b', 'Second', naming('L'), later);
    add('other', 'Other', naming('M'), now);
    add('gone', 'Gone', naming('L'), now);
    softDeleteWorkflow(db, 'gone', later);
    add('empty', 'Unset', naming(''), now);
    expect(listInactiveNamers(db)).toEqual(
      new Map([
        [
          'L',
          [
            { workflowId: 'b', name: 'Second', version: 1 },
            { workflowId: 'a', name: 'Movie Cleanup', version: 2 },
          ],
        ],
        ['M', [{ workflowId: 'other', name: 'Other', version: 1 }]],
      ]),
    );
    // active on its newest version: it feeds (or tried to), so it is no inactive namer
    setActiveVersion(db, 'b', 1, 'u1', later, 'L');
    // active on an older version: the newest still waits for activation
    setActiveVersion(db, 'a', 1, 'u1', later, null);
    expect(listInactiveNamers(db).get('L')).toEqual([
      { workflowId: 'a', name: 'Movie Cleanup', version: 2 },
    ]);
  });

  it('an active version row cannot be hard-deleted away', () => {
    insertWorkflow(db, { id: 'w2', kind: 'workflow', name: 'Main', graph, createdBy: 'u1' }, now);
    setActiveVersion(db, 'w2', 1, 'u1', later, null);
    expect(() =>
      db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run('w2'),
    ).toThrow();
    expect(listVersions(db, 'w2')).toHaveLength(1);
  });

  it('hard-deleting a workflow cascades to its versions', () => {
    appendVersion(
      db,
      { workflowId: 'w1', baseVersion: 1, graph, note: null, createdBy: 'u1' },
      later,
    );
    expect(listVersions(db, 'w1')).toHaveLength(2);
    db.prepare('DELETE FROM workflows WHERE id = ?').run('w1');
    expect(listVersions(db, 'w1')).toHaveLength(0);
  });

  it('a conflicting append leaves no extra version row', () => {
    expect(() =>
      appendVersion(
        db,
        { workflowId: 'w1', baseVersion: 5, graph, note: null, createdBy: 'u1' },
        later,
      ),
    ).toThrow(VersionConflictError);
    expect(listVersions(db, 'w1')).toHaveLength(1);
    expect(findWorkflow(db, 'w1')?.currentVersion).toBe(1);
  });

  it('listCurrentVersions returns the current version, not an older one', () => {
    const g2 = { ...graph, name: 'v2' } as typeof graph;
    appendVersion(
      db,
      { workflowId: 'w1', baseVersion: 1, graph: g2, note: 'second', createdBy: 'u1' },
      later,
    );
    const rows = listCurrentVersions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workflow.id).toBe('w1');
    expect(rows[0]?.version).toMatchObject({ ok: true, row: { version: 2, note: 'second' } });
  });

  it('listCurrentVersions returns the active version row when it differs from the current one', () => {
    insertWorkflow(db, { id: 'w2', kind: 'workflow', name: 'Main', graph, createdBy: 'u1' }, now);
    const g2 = { ...graph, name: 'v2' } as typeof graph;
    appendVersion(
      db,
      { workflowId: 'w2', baseVersion: 1, graph: g2, note: 'two', createdBy: 'u1' },
      later,
    );
    appendVersion(
      db,
      { workflowId: 'w2', baseVersion: 2, graph: g2, note: 'three', createdBy: 'u1' },
      later,
    );
    const find = () => listCurrentVersions(db).find((e) => e.workflow.id === 'w2');
    expect(find()?.active).toBeNull();
    setActiveVersion(db, 'w2', 1, 'u1', later, null);
    const entry = find();
    expect(entry?.version).toMatchObject({ ok: true, row: { version: 3 } });
    expect(entry?.active).toMatchObject({ ok: true, row: { version: 1, note: null } });
    setActiveVersion(db, 'w2', 3, 'u1', later, null);
    expect(find()?.active).toBeNull();
    expect(listCurrentVersions(db).find((e) => e.workflow.id === 'w1')?.active).toBeNull();
  });
});
