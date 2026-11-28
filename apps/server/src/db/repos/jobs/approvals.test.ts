import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../open.ts';
import {
  type ApprovalRow,
  deleteApproval,
  findApproval,
  insertApproval,
  listApprovals,
  parkedBytes,
} from './approvals.ts';
import { insertTestJob, now, seededDb } from './testing.ts';

let db: Database;
beforeEach(() => {
  db = seededDb();
});
afterEach(() => {
  db.close();
});

const parked = (jobId: string, extra: Partial<ApprovalRow> = {}): ApprovalRow => ({
  jobId,
  nodeId: 'ap',
  parkedAt: now.toISOString(),
  expiresAt: '2026-01-08T00:00:00.000Z',
  beforeBytes: 1000,
  afterBytes: 600,
  plan: null,
  outputProbe: null,
  ...extra,
});

describe('job approvals', () => {
  it('keeps one parked result per job, with its plan and output probe, until it is deleted', () => {
    insertTestJob(db, 'a', { state: 'verifying' });
    expect(findApproval(db, 'a')).toBeNull();
    const plan = { container: 'mkv', streams: [] } as unknown as ApprovalRow['plan'];
    insertApproval(db, parked('a', { plan, outputProbe: { sizeBytes: 600 } }));
    expect(findApproval(db, 'a')).toEqual(parked('a', { plan, outputProbe: { sizeBytes: 600 } }));
    expect(deleteApproval(db, 'a')).toBe(true);
    expect(deleteApproval(db, 'a')).toBe(false);
    expect(findApproval(db, 'a')).toBeNull();
  });

  it('lists the parked results oldest first and adds up their sizes', () => {
    insertTestJob(db, 'a', { state: 'verifying' });
    insertTestJob(db, 'b', { state: 'verifying' });
    expect(parkedBytes(db)).toBe(0);
    insertApproval(db, parked('b', { parkedAt: '2026-01-02T00:00:00.000Z', afterBytes: 50 }));
    insertApproval(db, parked('a', { afterBytes: 70 }));
    expect(listApprovals(db).map((r) => r.jobId)).toEqual(['a', 'b']);
    expect(parkedBytes(db)).toBe(120);
  });

  it('reads a corrupt plan or probe cell as none', () => {
    insertTestJob(db, 'a', { state: 'verifying' });
    insertApproval(db, parked('a'));
    db.prepare(
      "UPDATE job_approvals SET plan = 'nope', output_probe = '{' WHERE job_id = 'a'",
    ).run();
    expect(findApproval(db, 'a')).toMatchObject({ plan: null, outputProbe: null });
  });
});
