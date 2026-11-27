import type { JobState } from '@transcoda/shared';
import type { Database } from '../../open.ts';

// Earlier results of a file: what makes a newly queued file `already_processed`.

/** A real job's result that makes a newly queued file `already_processed` (see `findPriorRun`). */
export interface PriorRun {
  outcome: JobState;
  workflowVersion: number;
  createdAt: string;
  /** The file was that job's source, or it is the file the job wrote. */
  matched: 'source' | 'output';
}

/**
 * The reason of an `already_processed` job, naming the version. A `done` result's fingerprint is
 * the original's (the replacement has its own), so a source match means that original is back,
 * moved out of the recycle folder by hand (C5); an output match is that job's replacement, scanned
 * again. Every reason points to Process again.
 */
export function alreadyProcessedReason(prior: PriorRun): string {
  const base = `already ${prior.outcome} by v${prior.workflowVersion} on ${prior.createdAt}`;
  const what =
    prior.matched === 'output'
      ? '; this file is what that job wrote'
      : prior.outcome === 'done'
        ? '; this file is the original from before then (moved back from the recycle folder?)'
        : '';
  return `${base}${what}; use Process again to run it anyway`;
}

/**
 * Why a newly queued file needs no run: the newest result of a real job of `workflowId` that
 * processed it (`done`, `nothing_to_do`, `kept_original`) at any version, as its source or its
 * output; failing that, the newest `failed` result at `workflowVersion` (a newer version still
 * tries a file an older one failed on). `sameVersion` limits the processed match to
 * `workflowVersion` too, for dry runs (a preview of a version keeps its own history).
 * `processedOnly` skips the failed match (a job starting again after its own failure). Dry-run
 * results never count.
 */
export function findPriorRun(
  db: Database,
  key: string,
  workflowId: string,
  workflowVersion: number,
  opts: { sameVersion?: boolean; processedOnly?: boolean } = {},
): PriorRun | null {
  const processed = findProcessedResult(db, {
    by: 'fingerprint',
    key,
    workflowId,
    workflowVersion: opts.sameVersion ? workflowVersion : null,
  });
  if (processed) {
    const { outcome, workflowVersion: v, createdAt, matched } = processed;
    return { outcome, workflowVersion: v, createdAt, matched };
  }
  if (opts.processedOnly) return null;
  const failed = db
    .prepare(
      `SELECT r.created_at AS createdAt FROM job_results r JOIN jobs j ON j.id = r.job_id
       WHERE r.fingerprint = ? AND r.workflow_id = ? AND r.workflow_version = ?
         AND r.outcome = 'failed' AND j.dry_run = 0
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(key, workflowId, workflowVersion) as { createdAt: string } | undefined;
  return failed
    ? { outcome: 'failed', workflowVersion, createdAt: failed.createdAt, matched: 'source' }
    : null;
}

/** Outcomes that count as "already processed" for the Already processed node (not `failed`). */
const PROCESSED_SQL = ['done', 'nothing_to_do', 'kept_original'].map((s) => `'${s}'`).join(',');

/** A real job's result that the Already processed node counts as evidence. */
export interface ProcessedResult {
  jobId: string;
  workflowId: string;
  workflowVersion: number;
  outcome: 'done' | 'nothing_to_do' | 'kept_original';
  createdAt: string;
  /** How the file matched: it was the job's source, or it is the file the job wrote. */
  matched: 'source' | 'output';
  /** By what: the same file (fingerprint), or the same content (sampled hash). */
  by: 'fingerprint' | 'hash';
}

/**
 * The newest result of a real (not dry-run) job of `workflowId` (at `workflowVersion`, or any
 * version when null) that ended `done`, `nothing_to_do` or `kept_original` and whose source or
 * written output has this fingerprint (`by: 'fingerprint'`) or this sampled content hash
 * (`by: 'hash'`). `excludeJobId` leaves out the asking job itself.
 */
export function findProcessedResult(
  db: Database,
  q: {
    by: 'fingerprint' | 'hash';
    /** The `fingerprintKey`, or the content hash. */
    key: string;
    workflowId: string;
    workflowVersion: number | null;
    excludeJobId?: string;
  },
): ProcessedResult | null {
  const version = q.workflowVersion === null ? '' : 'AND r.workflow_version = @version';
  const [source, output] =
    q.by === 'fingerprint' ? ['fingerprint', 'output_fingerprint'] : ['source_hash', 'output_hash'];
  const select = (column: string, matched: string) =>
    `SELECT r.job_id AS jobId, r.workflow_id AS workflowId, r.workflow_version AS workflowVersion,
       r.outcome AS outcome, r.created_at AS createdAt, '${matched}' AS matched,
       '${q.by}' AS by, r.rowid AS rid
     FROM job_results r JOIN jobs j ON j.id = r.job_id
     WHERE r.${column} = @fp AND r.workflow_id = @workflowId ${version}
       AND r.outcome IN (${PROCESSED_SQL}) AND j.dry_run = 0 AND r.job_id <> @exclude`;
  const r = db
    .prepare(
      `SELECT jobId, workflowId, workflowVersion, outcome, createdAt, matched, by FROM (
         ${select(source, 'source')} UNION ALL ${select(output, 'output')}
       ) ORDER BY createdAt DESC, rid DESC LIMIT 1`,
    )
    .get({
      fp: q.key,
      workflowId: q.workflowId,
      exclude: q.excludeJobId ?? '',
      ...(q.workflowVersion === null ? {} : { version: q.workflowVersion }),
    }) as ProcessedResult | undefined;
  return r ?? null;
}
