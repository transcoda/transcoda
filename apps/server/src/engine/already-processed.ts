import type { JsonValue } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import { findProcessedResult, type ProcessedResult } from '../db/repos/jobs.ts';
import { findWorkflow } from '../db/repos/workflows.ts';

/** What Already processed asks: a workflow (null: the job's own) and a version (null: any). */
export interface AlreadyProcessedQuery {
  workflowId: string | null;
  version: number | null;
}

export interface AlreadyProcessedAnswer {
  processed: boolean;
  reason: string;
  findings: Record<string, JsonValue>;
}

/** The job and file Already processed decides for (the pipeline binds them). */
export interface AlreadyProcessedSubject {
  db: Database;
  jobId: string;
  /** The workflow the job runs: "This workflow". */
  jobWorkflowId: string;
  /** `fingerprintKey` of the file now at the job's path. */
  fingerprint: string;
  /**
   * The file's sampled content hash (engine/content-hash.ts), asked for only when no fingerprint
   * matched; null when it cannot be read.
   */
  contentHash(): Promise<string | null>;
}

const OUTCOME_WORDS: Record<ProcessedResult['outcome'], string> = {
  done: 'done by',
  nothing_to_do: 'nothing to do for',
  kept_original: 'original kept by',
};

/** The calendar day of a stored ISO time, in the server's time zone (`2026-10-28`). */
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** What the reason says about how the file matched the result. */
function matchText(r: ProcessedResult): string {
  if (r.by === 'fingerprint') {
    if (r.matched === 'output') return ' (this file is its output)';
    return r.outcome === 'done' ? ' (this file is its original)' : '';
  }
  if (r.matched === 'output') return ' (same content as its output)';
  return r.outcome === 'done'
    ? ' (same content as its original)'
    : ' (same content as the file it checked)';
}

/**
 * Has this file already been through the workflow? Yes when a real job of it (at the version, if
 * one is set) ended done, nothing to do or kept original with this file as its source or as the
 * file it wrote: first by fingerprint (the same file), then, only when that found nothing, by the
 * sampled content hash (the same content at any path: a copy, a re-download). A failed job and a
 * dry run never count; the job's own result is never evidence.
 */
export async function alreadyProcessed(
  s: AlreadyProcessedSubject,
  q: AlreadyProcessedQuery,
): Promise<AlreadyProcessedAnswer> {
  const workflowId = q.workflowId ?? s.jobWorkflowId;
  const name = findWorkflow(s.db, workflowId, { includeDeleted: true })?.name || workflowId;
  const wanted = q.version === null ? name : `${name} v${q.version}`;
  const base = { workflowId, version: q.version };
  const find = (by: 'fingerprint' | 'hash', key: string) =>
    findProcessedResult(s.db, {
      by,
      key,
      workflowId,
      workflowVersion: q.version,
      excludeJobId: s.jobId,
    });

  let r = find('fingerprint', s.fingerprint);
  let hash: string | null = null;
  if (r === null) {
    hash = await s.contentHash();
    if (hash !== null) r = find('hash', hash);
  }
  if (r === null) {
    return {
      processed: false,
      reason: `not processed by ${wanted}`,
      findings: { ...base, hashed: hash !== null },
    };
  }
  return {
    processed: true,
    reason: `${OUTCOME_WORDS[r.outcome]} ${name} v${r.workflowVersion} on ${dayOf(r.createdAt)}${matchText(r)}`,
    findings: {
      ...base,
      evidence: r.by,
      matched: r.matched,
      jobId: r.jobId,
      outcome: r.outcome,
      processedVersion: r.workflowVersion,
      at: r.createdAt,
    },
  };
}
