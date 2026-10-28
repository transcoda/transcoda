import { emptyGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertJob, insertJobResult, type JobResultRow } from '../../db/repos/jobs.ts';
import { insertLibrary } from '../../db/repos/libraries.ts';
import { insertRun } from '../../db/repos/runs.ts';
import { insertWorkflow } from '../../db/repos/workflows.ts';
import { createTestApp, type TestApp } from '../../test-app.ts';
import { asSession, login, type Session, send } from '../../test-http.ts';

// The server is in New York; it is 20:04 on Sunday 25 Oct there (00:04 UTC on the 26th).
const now = new Date('2026-10-26T00:04:00.000Z');

let t: TestApp;
let s: Session;
beforeEach(async () => {
  t = createTestApp({ start: now, timeZone: 'America/New_York' });
  s = await login(t);
  insertWorkflow(
    t.db,
    { id: 'w1', kind: 'workflow', name: 'Shrink', graph: emptyGraph('workflow'), createdBy: 'u' },
    now,
  );
  insertLibrary(
    t.db,
    { id: 'l1', name: 'TV', path: '/media/tv', recycleFolder: null, processHardlinked: false },
    now,
  );
  insertRun(
    t.db,
    {
      id: 'r1',
      libraryId: 'l1',
      workflowId: 'w1',
      workflowVersion: 1,
      requestedPath: '/media/tv',
      dryRun: false,
      testEncode: false,
      force: false,
      createdBy: 'u',
    },
    now,
  );
});
afterEach(async () => {
  await t.close();
});

/** A replaced file that saved `saved` bytes, its result created at `createdAt`. */
function replaced(id: string, createdAt: string, saved: number): void {
  insertJob(
    t.db,
    {
      id,
      runId: 'r1',
      libraryId: 'l1',
      fileId: null,
      path: `/media/tv/${id}.mkv`,
      workflowId: 'w1',
      workflowVersion: 1,
      dryRun: false,
      testEncode: false,
      state: 'done',
      priority: 0,
    },
    now,
  );
  const row: JobResultRow = {
    jobId: id,
    fingerprint: id,
    workflowId: 'w1',
    workflowVersion: 1,
    outcome: 'done',
    beforeBytes: saved + 100,
    afterBytes: 100,
    estimatedBytes: null,
    command: null,
    plan: null,
    replacedTo: 'recycle',
    logPath: null,
    warnings: [],
    problems: [],
    outputProbe: null,
    sourceDamaged: false,
    createdAt,
  };
  insertJobResult(t.db, row);
}

const json = async <T>(res: Response): Promise<T> => {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const get = (path: string) => send(t, 'GET', path, { headers: asSession(s, false) });

describe('jobs.history', () => {
  it('jobs.history returns seven server-local days ending today', async () => {
    const h = await json<{ timeZone: string; days: Array<{ date: string }> }>(
      await get('/jobs/history'),
    );
    expect(h.timeZone).toBe('America/New_York');
    expect(h.days.map((d) => d.date)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it("jobs.stats without since counts from the server's midnight, not UTC's", async () => {
    replaced('evening', '2026-10-25T23:30:00.000Z', 1000); // 19:30 on the 25th in New York
    replaced('night-before', '2026-10-25T03:00:00.000Z', 50); // 23:00 on the 24th in New York
    const stats = await json<{ savedBytes: number; files: number }>(await get('/jobs/stats'));
    expect(stats).toMatchObject({ savedBytes: 1000, files: 1 });
  });

  it("today's tile equals today's bar", async () => {
    replaced('a', '2026-10-25T23:30:00.000Z', 1000);
    replaced('b', '2026-10-25T05:00:00.000Z', 300);
    replaced('c', '2026-10-25T03:00:00.000Z', 50);
    const stats = await json<{ savedBytes: number }>(await get('/jobs/stats'));
    const h = await json<{
      days: Array<{ savedBytes: number }>;
      allTime: { savedBytes: number; files: number; since: string | null };
    }>(await get('/jobs/history'));
    expect(stats.savedBytes).toBe(1300);
    expect(h.days[6]?.savedBytes).toBe(stats.savedBytes);
    expect(h.days[5]?.savedBytes).toBe(50);
    expect(h.allTime).toEqual({
      savedBytes: 1350,
      files: 3,
      since: '2026-10-25T03:00:00.000Z',
    });
  });
});
