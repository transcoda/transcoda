import {
  type JobPlan,
  type JobState,
  type JsonValue,
  type NodeProblem,
  NodeProblemSchema,
} from '@transcoda/shared';
import type { Database } from '../../open.ts';
import { parseJson, parseStringList, toJson } from './rows.ts';

// The job_results table: one result per finished job.

export interface JobResultRow {
  jobId: string;
  /** `fingerprintKey` of the input file. */
  fingerprint: string;
  workflowId: string;
  workflowVersion: number;
  outcome: JobState;
  beforeBytes: number | null;
  afterBytes: number | null;
  estimatedBytes: number | null;
  command: string | null;
  plan: JobPlan | null;
  replacedTo: 'recycle' | 'deleted' | null;
  logPath: string | null;
  warnings: string[];
  /** Problems the plugin finish actions reported; separate from `warnings`. */
  problems: string[];
  /** The warnings and problems that belong to one node, with that node. Absent reads as []. */
  nodeProblems?: NodeProblem[];
  /**
   * The probe verify read of the output, as the job page reads it (a JobProbe: no raw JSON); null
   * when nothing was verified or the job failed or was canceled after verify. Rows written before
   * that was decided may hold the whole ProbeResult (with `raw`).
   */
  outputProbe: JsonValue | null;
  /** The original was kept because the source is damaged (decode errors it reproduces). */
  sourceDamaged: boolean;
  /**
   * `fingerprintKey` of the file the job wrote, read at its final path once it was written (the
   * replaced original, a move-copy destination); null when nothing was written or it could not
   * be read. Absent reads as null.
   */
  outputFingerprint?: string | null;
  /** Sampled content hash (engine/content-hash.ts) of the source when a real job started. */
  sourceHash?: string | null;
  /** Sampled content hash of the written file at its final path (done results). */
  outputHash?: string | null;
  createdAt: string;
}

interface DbResult {
  job_id: string;
  fingerprint: string;
  workflow_id: string;
  workflow_version: number;
  outcome: JobState;
  before_bytes: number | null;
  after_bytes: number | null;
  estimated_bytes: number | null;
  command: string | null;
  plan: string | null;
  replaced_to: 'recycle' | 'deleted' | null;
  log_path: string | null;
  warnings: string;
  problems_json: string;
  node_problems_json: string;
  output_probe: string | null;
  source_damaged: number;
  output_fingerprint: string | null;
  source_hash: string | null;
  output_hash: string | null;
  created_at: string;
}

/** A node problems cell; a corrupt cell or entry is left out (one bad row must not break a read). */
const parseNodeProblems = (s: string): NodeProblem[] => {
  try {
    const v: unknown = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => {
      const parsed = NodeProblemSchema.safeParse(x);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
};

const toResult = (r: DbResult): JobResultRow => ({
  jobId: r.job_id,
  fingerprint: r.fingerprint,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  outcome: r.outcome,
  beforeBytes: r.before_bytes,
  afterBytes: r.after_bytes,
  estimatedBytes: r.estimated_bytes,
  command: r.command,
  plan: parseJson<JobPlan>(r.plan),
  replacedTo: r.replaced_to,
  logPath: r.log_path,
  warnings: parseStringList(r.warnings),
  problems: parseStringList(r.problems_json),
  nodeProblems: parseNodeProblems(r.node_problems_json),
  outputProbe: parseJson<JsonValue>(r.output_probe),
  sourceDamaged: r.source_damaged === 1,
  outputFingerprint: r.output_fingerprint,
  sourceHash: r.source_hash,
  outputHash: r.output_hash,
  createdAt: r.created_at,
});

export function insertJobResult(db: Database, r: JobResultRow): void {
  db.prepare(
    `INSERT INTO job_results (job_id, fingerprint, workflow_id, workflow_version, outcome, before_bytes,
       after_bytes, estimated_bytes, command, plan, replaced_to, log_path, warnings, problems_json, node_problems_json,
       output_probe, source_damaged, output_fingerprint, source_hash, output_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.jobId,
    r.fingerprint,
    r.workflowId,
    r.workflowVersion,
    r.outcome,
    r.beforeBytes,
    r.afterBytes,
    r.estimatedBytes,
    r.command,
    toJson(r.plan),
    r.replacedTo,
    r.logPath,
    JSON.stringify(r.warnings),
    JSON.stringify(r.problems),
    JSON.stringify(r.nodeProblems ?? []),
    toJson(r.outputProbe),
    r.sourceDamaged ? 1 : 0,
    r.outputFingerprint ?? null,
    r.sourceHash ?? null,
    r.outputHash ?? null,
    r.createdAt,
  );
}

export function findJobResult(db: Database, jobId: string): JobResultRow | null {
  const r = db.prepare('SELECT * FROM job_results WHERE job_id = ?').get(jobId) as
    | DbResult
    | undefined;
  return r ? toResult(r) : null;
}

/** after/before of the newest `done` results of a workflow (any version), newest first. */
export function recentRatios(db: Database, workflowId: string, limit: number): number[] {
  const rows = db
    .prepare(
      `SELECT CAST(after_bytes AS REAL) / before_bytes AS ratio FROM job_results
       WHERE workflow_id = ? AND outcome = 'done' AND before_bytes > 0 AND after_bytes IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(workflowId, limit) as { ratio: number }[];
  return rows.map((r) => r.ratio);
}
