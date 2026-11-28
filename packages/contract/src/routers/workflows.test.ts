import * as shared from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  contract,
  WorkflowActivateInputSchema,
  WorkflowCreateInputSchema,
  WorkflowDetailSchema,
  WorkflowDuplicateInputSchema,
  WorkflowSaveInputSchema,
  WorkflowSaveOutputSchema,
  WorkflowSummarySchema,
  WorkflowValidateInputSchema,
} from '../index.ts';
import { errorsOf, route } from './testing.ts';

describe('workflows router', () => {
  it('workflows.create takes an optional graph and note; duplicate takes id, name, note', () => {
    const graph = { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] };
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', graph, note: 'n' })
        .success,
    ).toBe(true);
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', note: 'x'.repeat(121) })
        .success,
    ).toBe(false);
    expect(WorkflowDuplicateInputSchema.safeParse({ id: 'w', name: 'copy' }).success).toBe(true);
    expect(contract.workflows.duplicate['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/duplicate',
    });
  });

  it('save declares HIDDEN_URL_UNKNOWN and takes restoredFrom (final review I3, I4)', () => {
    expect(errorsOf(contract.workflows.save)).toContain('HIDDEN_URL_UNKNOWN');
    const base = {
      id: 'w',
      baseVersion: 3,
      graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] },
    };
    expect(WorkflowSaveInputSchema.parse({ ...base, restoredFrom: 1 }).restoredFrom).toBe(1);
    expect(WorkflowSaveInputSchema.safeParse({ ...base, restoredFrom: 0 }).success).toBe(false);
  });

  it('workflows router: activate and deactivate replace setMode', () => {
    expect(route(contract.workflows.activate)).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/activate',
    });
    expect(route(contract.workflows.deactivate)).toMatchObject({
      method: 'POST',
      path: '/workflows/{id}/deactivate',
    });
    expect(errorsOf(contract.workflows.activate)).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'KIND_MISMATCH', 'WORKFLOW_INVALID']),
    );
    expect(errorsOf(contract.workflows.deactivate)).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'KIND_MISMATCH']),
    );
  });

  it('activate input requires confirm: true and a version >= 1', () => {
    const ok = WorkflowActivateInputSchema.safeParse;
    expect(ok({ id: 'w', version: 2 }).success).toBe(false);
    expect(ok({ id: 'w', version: 2, confirm: false }).success).toBe(false);
    expect(ok({ id: 'w', version: 0, confirm: true }).success).toBe(false);
    expect(ok({ id: 'w', version: 2, confirm: true }).success).toBe(true);
  });

  it('WorkflowSummarySchema takes active null or the object and no longer knows mode', () => {
    const AT = '2026-10-17T10:00:00.000Z';
    const base = {
      id: 'w',
      name: 'A',
      kind: 'workflow',
      currentVersion: 3,
      valid: true,
      errorCount: 0,
      usesOutdatedSubworkflow: false,
      usedBy: [],
      feedsLibrary: null,
      libraryInput: null,
      trigger: null,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(WorkflowSummarySchema.safeParse({ ...base, active: null }).success).toBe(true);
    expect(
      WorkflowSummarySchema.safeParse({
        ...base,
        active: { version: 3, runnable: true, activatedAt: AT, activatedBy: 'u1' },
      }).success,
    ).toBe(true);
    expect(
      WorkflowSummarySchema.safeParse({ ...base, active: null, mode: 'enabled' }).success,
    ).toBe(true);
    expect('mode' in WorkflowSummarySchema.shape).toBe(false);
    expect('needsReview' in WorkflowSummarySchema.shape).toBe(false);
    expect('reviewNote' in WorkflowSummarySchema.shape).toBe(false);
    expect('WorkflowModeSchema' in shared).toBe(false);
  });

  it('WorkflowSaveOutputSchema is { version, issues, valid, active, changes }', () => {
    expect(Object.keys(WorkflowSaveOutputSchema.shape)).toEqual([
      'version',
      'issues',
      'valid',
      'active',
      'changes',
    ]);
  });

  it('save input takes an optional trimmed note of at most 120 characters', () => {
    const base = {
      id: 'w',
      baseVersion: 1,
      graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [], groups: [] },
    };
    expect(WorkflowSaveInputSchema.parse({ ...base, note: ' Layout only ' }).note).toBe(
      'Layout only',
    );
    expect(WorkflowSaveInputSchema.parse(base).note).toBeUndefined();
    expect(WorkflowSaveInputSchema.safeParse({ ...base, note: 'x'.repeat(121) }).success).toBe(
      false,
    );
  });

  it('graph inputs take format 1 too (the server upgrades it); details carry format 2 only', () => {
    const v1 = { formatVersion: 1, kind: 'workflow', nodes: [], edges: [], groups: [] };
    expect(WorkflowSaveInputSchema.safeParse({ id: 'w', baseVersion: 1, graph: v1 }).success).toBe(
      true,
    );
    expect(
      WorkflowCreateInputSchema.safeParse({ name: 'a', kind: 'workflow', graph: v1 }).success,
    ).toBe(true);
    expect(WorkflowValidateInputSchema.safeParse({ graph: v1 }).success).toBe(true);
    expect(WorkflowDetailSchema.shape.graph.safeParse(v1).success).toBe(false);
  });

  it('save input rejects a structurally broken graph (groups missing)', () => {
    expect(
      WorkflowSaveInputSchema.safeParse({
        id: 'w',
        baseVersion: 1,
        graph: { formatVersion: 2, kind: 'workflow', nodes: [], edges: [] },
      }).success,
    ).toBe(false);
  });
});
