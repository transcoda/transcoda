import { type TraceEntry, TraceEntrySchema } from '@transcoda/shared';
import type { Database } from '../../open.ts';

// The job_trace table: what each node of the walk did, in order.

/**
 * Stores an entry at its own `seq` (the walk numbers entries in the order it makes them, across
 * attempts) and returns that seq. A seq the job already has is a programming error (throws).
 */
export function appendTrace(db: Database, jobId: string, entry: TraceEntry): number {
  db.prepare('INSERT INTO job_trace (job_id, seq, entry) VALUES (?, ?, ?)').run(
    jobId,
    entry.seq,
    JSON.stringify(entry),
  );
  return entry.seq;
}

/** The seq the job's next trace entry gets: one past the highest stored (1 for none). */
export function nextTraceSeq(db: Database, jobId: string): number {
  const { seq } = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_trace WHERE job_id = ?')
    .get(jobId) as { seq: number };
  return seq;
}

export function listTrace(db: Database, jobId: string): TraceEntry[] {
  const rows = db
    .prepare('SELECT entry FROM job_trace WHERE job_id = ? ORDER BY seq')
    .all(jobId) as { entry: string }[];
  return rows.map((r) => TraceEntrySchema.parse(JSON.parse(r.entry)));
}
