import * as shared from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import {
  contract,
  errorDefs,
  LibrariesListOutputSchema,
  LibraryCreateInputSchema,
  LibraryFeedsSchema,
  LibraryFileInputSchema,
  LibraryFilesInputSchema,
  LibraryGetOutputSchema,
  LibraryRefSchema,
  LibrarySchema,
  LibraryUpdateInputSchema,
  REMOVED_DEFAULT_WORKFLOW,
  WorkflowSummarySchema,
} from '../index.ts';
import { errorsOf } from './testing.ts';

describe('libraries router', () => {
  it('the library files input has defaults, bounds the page and refuses a season without a show', () => {
    expect(LibraryFilesInputSchema.parse({ id: 'l' })).toEqual({
      id: 'l',
      sort: 'title',
      desc: false,
      offset: 0,
      limit: 100,
    });
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', limit: 200 }).success).toBe(true);
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', limit: 201 }).success).toBe(false);
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', show: 's', season: 'x' }).success).toBe(
      false,
    );
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', season: '1' }).success).toBe(false);
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', show: 's', season: 'none' }).success).toBe(
      true,
    );
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', sort: 'path' }).success).toBe(false);
  });

  it('the library files input can ask for damaged files only', () => {
    expect(LibraryFilesInputSchema.parse({ id: 'l', damaged: true })).toMatchObject({
      damaged: true,
    });
    expect(LibraryFilesInputSchema.safeParse({ id: 'l', damaged: 'yes' }).success).toBe(false);
  });

  it('a library read carries its damaged count and the Replace damaged file steps it runs', () => {
    const library = {
      id: 'l',
      name: 'Movies',
      path: '/media/movies',
      recycleFolder: null,
      processHardlinked: false,
      verifyFullDecode: false,
      runHours: null,
      watchFolder: true,
      feeds: null,
      namedByInactive: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      clock: { now: '2026-11-01T00:00:00.000Z', timeZone: 'UTC' },
      fileCount: 3,
    };
    expect(
      LibraryGetOutputSchema.safeParse({
        ...library,
        damagedCount: 1,
        replaceDamaged: ['Replace damaged file (Radarr)'],
      }).success,
    ).toBe(true);
    expect(LibraryGetOutputSchema.safeParse(library).success).toBe(false);
    expect(
      LibraryGetOutputSchema.safeParse({ ...library, damagedCount: -1, replaceDamaged: [] })
        .success,
    ).toBe(false);
  });

  it('library file detail bounds the job history page', () => {
    expect(LibraryFileInputSchema.parse({ id: 'l', fileId: 'f' })).toEqual({
      id: 'l',
      fileId: 'f',
      jobsOffset: 0,
      jobsLimit: 50,
    });
    expect(LibraryFileInputSchema.safeParse({ id: 'l', fileId: 'f', jobsLimit: 201 }).success).toBe(
      false,
    );
    expect(LibraryFileInputSchema.safeParse({ id: 'l', fileId: 'f', jobsLimit: 0 }).success).toBe(
      false,
    );
  });

  it('library trigger vocabulary: error codes, activate errors, LIBRARY_MISSING issue', () => {
    expect(errorDefs.LIBRARY_TAKEN.status).toBe(409);
    expect(errorDefs.LIBRARY_MISSING.status).toBe(400);
    expect(errorDefs.NO_FEEDING_WORKFLOW.status).toBe(400);
    expect('NO_DEFAULT_WORKFLOW' in errorDefs).toBe(false);
    expect(errorsOf(contract.jobs.queue)).toContain('NO_FEEDING_WORKFLOW');
    expect(errorsOf(contract.jobs.queue)).not.toContain('NO_DEFAULT_WORKFLOW');
    expect(
      errorDefs.LIBRARY_TAKEN.data.safeParse({
        library: { id: 'l', name: 'Shows' },
        workflow: { id: 'w', name: 'Shrink', version: 4 },
      }).success,
    ).toBe(true);
    expect(errorDefs.LIBRARY_MISSING.data.safeParse({ libraryId: 'gone' }).success).toBe(true);
    expect(errorsOf(contract.workflows.activate)).toEqual(
      expect.arrayContaining(['LIBRARY_TAKEN', 'LIBRARY_MISSING']),
    );
    expect(shared.ISSUE_CODES).toContain('LIBRARY_MISSING');
    expect(LibraryRefSchema.safeParse({ id: 'l', name: 'Shows' }).success).toBe(true);
    expect(LibraryFeedsSchema.safeParse(null).success).toBe(true);
    expect(
      LibraryFeedsSchema.safeParse({ workflowId: 'w', name: 'Shrink', version: 1.5 }).success,
    ).toBe(false);
    expect(
      LibraryFeedsSchema.safeParse({ workflowId: 'w', name: 'Shrink', version: 2 }).success,
    ).toBe(true);
  });

  it('library trigger read fields: feedsLibrary, libraryInput, feeds, notices, dismissNotices', () => {
    const AT = '2026-10-17T10:00:00.000Z';
    const summary = {
      id: 'w',
      name: 'A',
      kind: 'workflow',
      active: null,
      currentVersion: 1,
      valid: true,
      errorCount: 0,
      usesOutdatedSubworkflow: false,
      usedBy: [],
      createdAt: AT,
      updatedAt: AT,
    };
    expect(WorkflowSummarySchema.safeParse(summary).success).toBe(false);
    expect(
      WorkflowSummarySchema.safeParse({
        ...summary,
        feedsLibrary: { id: 'l', name: 'Shows' },
        libraryInput: { id: 'l', name: null },
        trigger: 'library',
      }).success,
    ).toBe(true);
    expect('feeds' in LibrarySchema.shape).toBe(true);
    expect(
      LibrarySchema.shape.namedByInactive.safeParse([
        { workflowId: 'w', name: 'Movie Cleanup', version: 5 },
      ]).success,
    ).toBe(true);
    expect(LibrarySchema.shape.namedByInactive.safeParse(null).success).toBe(false);
    expect(
      LibrariesListOutputSchema.safeParse({
        libraries: [],
        notices: ['Shows has no workflow now'],
        clock: { now: '2026-10-22T12:00:00.000Z', timeZone: 'Europe/Berlin' },
      }).success,
    ).toBe(true);
    expect(LibrariesListOutputSchema.safeParse({ libraries: [] }).success).toBe(false);
    expect(contract.libraries.dismissNotices['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/libraries/notices/dismiss',
    });
  });

  it('defaultWorkflowId is removed: DEFAULT_WORKFLOW_INVALID gone, the inputs refuse it with REMOVED_DEFAULT_WORKFLOW', () => {
    expect('DEFAULT_WORKFLOW_INVALID' in errorDefs).toBe(false);
    expect(errorsOf(contract.libraries.create)).not.toContain('DEFAULT_WORKFLOW_INVALID');
    expect(errorsOf(contract.libraries.update)).not.toContain('DEFAULT_WORKFLOW_INVALID');
    expect('defaultWorkflowId' in LibrarySchema.shape).toBe(false);
    expect(REMOVED_DEFAULT_WORKFLOW).toBe(
      "defaultWorkflowId was removed: a workflow's Library input chooses its library",
    );
    for (const [schema, base] of [
      [LibraryCreateInputSchema, { name: 'Shows', path: '/media/shows' }],
      [LibraryUpdateInputSchema, { id: 'l' }],
    ] as const) {
      expect(schema.safeParse(base).success).toBe(true);
      for (const value of ['w1', null]) {
        const parsed = schema.safeParse({ ...base, defaultWorkflowId: value });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toBe(REMOVED_DEFAULT_WORKFLOW);
      }
    }
  });
});
