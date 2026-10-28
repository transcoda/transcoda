import type { ProbeResult } from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import { findProcessedResult, type ProcessedResult } from '../db/repos/jobs.ts';
import { findWorkflow } from '../db/repos/workflows.ts';
import { parseTranscodaTag, transcodaTagOf } from './transcoda-tag.ts';

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
  probe: Pick<ProbeResult, 'raw'>;
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

/**
 * Has this file already been through the workflow? Yes when a real job of it (at the version, if
 * one is set) ended done, nothing to do or kept original with this file as its source or as the
 * file it wrote, or when the file's TRANSCODA tag names it. A failed job and a dry run never
 * count. The job's own result is never evidence.
 */
export function alreadyProcessed(
  s: AlreadyProcessedSubject,
  q: AlreadyProcessedQuery,
): AlreadyProcessedAnswer {
  const workflowId = q.workflowId ?? s.jobWorkflowId;
  const name = findWorkflow(s.db, workflowId, { includeDeleted: true })?.name || workflowId;
  const wanted = q.version === null ? name : `${name} v${q.version}`;
  const base = { workflowId, version: q.version };

  const r = findProcessedResult(s.db, {
    fingerprint: s.fingerprint,
    workflowId,
    workflowVersion: q.version,
    excludeJobId: s.jobId,
  });
  if (r !== null) {
    const what =
      r.matched === 'output'
        ? ' (this file is its output)'
        : r.outcome === 'done'
          ? ' (this file is its original)'
          : '';
    return {
      processed: true,
      reason: `${OUTCOME_WORDS[r.outcome]} ${name} v${r.workflowVersion} on ${dayOf(r.createdAt)}${what}`,
      findings: {
        ...base,
        evidence: 'result',
        matched: r.matched,
        jobId: r.jobId,
        outcome: r.outcome,
        processedVersion: r.workflowVersion,
        at: r.createdAt,
      },
    };
  }

  const tagged = parseTranscodaTag(transcodaTagOf(s.probe)).filter(
    (e) => e.workflowId === workflowId && (q.version === null || e.version === q.version),
  );
  const last = tagged.at(-1);
  if (last !== undefined) {
    return {
      processed: true,
      reason: `tagged by ${name} v${last.version}`,
      findings: { ...base, evidence: 'tag', processedVersion: last.version },
    };
  }
  return {
    processed: false,
    reason: `not processed by ${wanted}`,
    findings: { ...base, evidence: null },
  };
}
