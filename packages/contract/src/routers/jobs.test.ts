import { describe, expect, it } from 'vitest';
import {
  JobSchema,
  JobsListInputSchema,
  JobsListOutputSchema,
  JobsQueueFilesInputSchema,
  JobsQueueFilesPreviewInputSchema,
  JobsQueueInputSchema,
  JobsQueueOutputSchema,
  QUEUE_FILES_MAX,
  RunSchema,
} from '../index.ts';

describe('jobs router', () => {
  it('jobs.queue input defaults dryRun, force, fileOnly and priority and bounds priority', () => {
    expect(JobsQueueInputSchema.parse({ path: '/media/a.mkv' })).toEqual({
      path: '/media/a.mkv',
      dryRun: false,
      force: false,
      fileOnly: false,
      priority: 0,
    });
    expect(JobsQueueInputSchema.parse({ path: '/media/a.mkv', fileOnly: true }).fileOnly).toBe(
      true,
    );
    expect(JobsQueueInputSchema.safeParse({ path: '' }).success).toBe(false);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', priority: 11 }).success).toBe(false);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', priority: 1.5 }).success).toBe(false);
  });

  it('jobs.queue input takes workflowVersion only with dryRun true; output carries dryRun and note', () => {
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: true, workflowVersion: 2 }).success,
    ).toBe(true);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', workflowVersion: 2 }).success).toBe(false);
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, workflowVersion: 2 }).success,
    ).toBe(false);
    expect(
      JobsQueueOutputSchema.safeParse({
        runId: 'r',
        jobIds: [],
        dryRun: true,
        note: 'no active version',
        workflowVersion: 3,
        testEncode: false,
      }).success,
    ).toBe(true);
  });

  it('jobs.queue input takes testEncode only with dryRun true; Job, Run and the queue output carry it', () => {
    const real = JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, testEncode: true });
    expect(real.success).toBe(false);
    expect(real.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['testEncode'], 'only a dry run can test-encode'],
    ]);
    expect(JobsQueueInputSchema.safeParse({ path: '/a', testEncode: true }).success).toBe(false);
    expect(
      JobsQueueInputSchema.safeParse({ path: '/a', dryRun: false, testEncode: false }).success,
    ).toBe(true);
    const dry = JobsQueueInputSchema.parse({ path: '/a', dryRun: true });
    expect(dry.testEncode).toBeUndefined();
    expect(
      JobsQueueInputSchema.parse({ path: '/a', dryRun: true, testEncode: true }).testEncode,
    ).toBe(true);
    expect(JobSchema.shape.testEncode.safeParse(undefined).success).toBe(false);
    expect(RunSchema.shape.testEncode.safeParse(undefined).success).toBe(false);
    expect(JobsQueueOutputSchema.shape.testEncode.safeParse(true).success).toBe(true);
  });

  it('a job carries its parked result while it waits for approval; the list filters and counts them', () => {
    const approval = {
      parkedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-08T00:00:00.000Z',
      beforeBytes: 1000,
      afterBytes: 600,
    };
    expect(JobSchema.shape.approval.parse(approval)).toEqual(approval);
    expect(JobSchema.shape.approval.parse(null)).toBeNull();
    expect(JobSchema.shape.approval.safeParse(undefined).success).toBe(false);
    expect(JobsListInputSchema.parse({ awaitingApproval: true }).awaitingApproval).toBe(true);
    expect(JobsListOutputSchema.shape.awaitingApprovalCount.safeParse(2).success).toBe(true);
  });
});

describe('jobs.queueFiles input', () => {
  const base = { libraryId: 'l', workflowId: 'w' };
  it('defaults dryRun, force, priority and start', () => {
    expect(JobsQueueFilesInputSchema.parse({ ...base, fileIds: ['f'] })).toEqual({
      ...base,
      fileIds: ['f'],
      dryRun: false,
      force: false,
      priority: 0,
      start: 'now',
    });
    expect(JobsQueueFilesPreviewInputSchema.parse({ ...base, show: 'k' })).toEqual({
      ...base,
      show: 'k',
      dryRun: false,
    });
  });

  it('takes exactly one of fileIds, paths and show, with the same message in both schemas', () => {
    for (const schema of [JobsQueueFilesInputSchema, JobsQueueFilesPreviewInputSchema]) {
      expect(schema.safeParse({ ...base, fileIds: ['f'], paths: ['/a'] }).success).toBe(false);
      expect(schema.safeParse({ ...base, fileIds: ['f'], show: 'k' }).success).toBe(false);
      expect(schema.safeParse(base).success).toBe(false);
      expect(schema.safeParse({ ...base, paths: ['/a'] }).success).toBe(true);
      expect(schema.safeParse({ ...base, show: 'k', season: '2' }).success).toBe(true);
      expect(schema.safeParse({ ...base, show: 'k', season: 'x' }).success).toBe(false);
      const r = schema.safeParse({ ...base, fileIds: ['f'], paths: ['/a'] });
      expect(r.success ? '' : r.error.issues[0]?.message).toBe(
        'send exactly one of fileIds, paths or show',
      );
    }
  });

  it('a season needs a show: with fileIds, paths or alone it is refused', () => {
    for (const schema of [JobsQueueFilesInputSchema, JobsQueueFilesPreviewInputSchema]) {
      for (const sel of [{ fileIds: ['f'] }, { paths: ['/a'] }]) {
        const r = schema.safeParse({ ...base, ...sel, season: '1' });
        expect(r.success).toBe(false);
        expect(r.success ? null : r.error.issues.map((i) => [i.path, i.message])).toEqual([
          [['season'], 'season needs show'],
        ]);
      }
      expect(schema.safeParse({ ...base, show: 'k', season: 'none' }).success).toBe(true);
    }
  });

  it('refuses 5001 ids or paths, an empty list and an out-of-range priority or start', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
    expect(
      JobsQueueFilesInputSchema.safeParse({ ...base, fileIds: ids(QUEUE_FILES_MAX) }).success,
    ).toBe(true);
    expect(
      JobsQueueFilesInputSchema.safeParse({ ...base, fileIds: ids(QUEUE_FILES_MAX + 1) }).success,
    ).toBe(false);
    expect(
      JobsQueueFilesPreviewInputSchema.safeParse({ ...base, fileIds: ids(5001) }).success,
    ).toBe(false);
    expect(JobsQueueFilesInputSchema.safeParse({ ...base, fileIds: [] }).success).toBe(false);
    expect(JobsQueueFilesInputSchema.safeParse({ ...base, paths: [''] }).success).toBe(false);
    expect(
      JobsQueueFilesInputSchema.safeParse({ ...base, fileIds: ['f'], priority: 11 }).success,
    ).toBe(false);
    expect(
      JobsQueueFilesInputSchema.safeParse({ ...base, fileIds: ['f'], start: 'later' }).success,
    ).toBe(false);
  });
});
