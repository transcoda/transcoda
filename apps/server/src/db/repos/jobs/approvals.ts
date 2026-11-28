import type { JobPlan, JsonValue } from '@transcoda/shared';
import type { Database } from '../../open.ts';
import { toJson } from './rows.ts';

// Results parked by an Approval finish step until a person approves or rejects them
// (docs/dev/engine.md, "Approval"): one row per job, gone with the job.

export interface ApprovalRow {
  jobId: string;
  /** The Approval node that parked the result. */
  nodeId: string;
  parkedAt: string;
  /** When the job is rejected for want of an answer. */
  expiresAt: string;
  beforeBytes: number;
  afterBytes: number;
  /** The plan the job page shows while the job has no result row. */
  plan: JobPlan | null;
  /** What verify read of the parked output (a JobProbe), for the job page's before and after. */
  outputProbe: JsonValue | null;
}

interface DbApproval {
  job_id: string;
  node_id: string;
  parked_at: string;
  expires_at: string;
  before_bytes: number;
  after_bytes: number;
  plan: string | null;
  output_probe: string | null;
}

/** A JSON object cell, or null for none or a corrupt one: a bad row must not break the job page. */
function parseObject<T>(s: string | null): T | null {
  if (s === null) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

const toRow = (r: DbApproval): ApprovalRow => ({
  jobId: r.job_id,
  nodeId: r.node_id,
  parkedAt: r.parked_at,
  expiresAt: r.expires_at,
  beforeBytes: r.before_bytes,
  afterBytes: r.after_bytes,
  plan: parseObject<JobPlan>(r.plan),
  outputProbe: parseObject<JsonValue>(r.output_probe),
});

export function insertApproval(db: Database, row: ApprovalRow): void {
  db.prepare(
    `INSERT INTO job_approvals (job_id, node_id, parked_at, expires_at, before_bytes, after_bytes,
       plan, output_probe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.jobId,
    row.nodeId,
    row.parkedAt,
    row.expiresAt,
    row.beforeBytes,
    row.afterBytes,
    toJson(row.plan),
    toJson(row.outputProbe),
  );
}

export function findApproval(db: Database, jobId: string): ApprovalRow | null {
  const r = db.prepare('SELECT * FROM job_approvals WHERE job_id = ?').get(jobId) as
    | DbApproval
    | undefined;
  return r ? toRow(r) : null;
}

/** False when the job had no parked result. */
export function deleteApproval(db: Database, jobId: string): boolean {
  return db.prepare('DELETE FROM job_approvals WHERE job_id = ?').run(jobId).changes > 0;
}

/** Every parked result, oldest first. */
export function listApprovals(db: Database): ApprovalRow[] {
  return (
    db.prepare('SELECT * FROM job_approvals ORDER BY parked_at, job_id').all() as DbApproval[]
  ).map(toRow);
}

/** The bytes every parked result holds in the transcode dir now. */
export function parkedBytes(db: Database): number {
  const r = db.prepare('SELECT COALESCE(SUM(after_bytes), 0) AS n FROM job_approvals').get() as {
    n: number;
  };
  return r.n;
}
