import {
  ACTIVE_JOB_STATES,
  type FailureCode,
  FINAL_JOB_STATES,
  type JobState,
  type Lane,
  type StoredJobMedia,
} from '@transcoda/shared';
import type { Fingerprint } from '../files.ts';

// The jobs table's row, its JSON cells and the helpers every jobs/ file reads rows with.

export interface JobProgress {
  percent: number | null;
  outTimeSeconds: number;
  speed: number | null;
  fps: number | null;
  sizeBytes: number | null;
  etaSeconds: number | null;
  /** Verifying only: which part of the verify runs; `done`/`total` count its checks. */
  verify?: {
    stage: 'checks' | 'full-decode' | 'source';
    done: number | null;
    total: number | null;
  };
}

/** An *intent*: the action the replace is about to perform (written before it); the sweep decides from the disk, not from the step. */
export interface ReplaceJournal {
  step: 'checking' | 'writing_tmp' | 'moving_original' | 'installing_tmp' | 'cleaning';
  originalPath: string;
  tmpPath: string;
  outputPath: string;
  /** Where the original moves: its path in the recycle folder. */
  copyPath: string;
  /** The library root: the sweep decides nothing while it is unreachable (an unmounted share). */
  libraryRoot: string;
  /** Only in journals from before 2026-11-27; `false`: a `.orig` copy the sweep leaves alone. */
  recycling?: boolean;
  fingerprint: Fingerprint;
  outputBytes: number;
}

/** One node of the file's path through the workflow and the file output it left by (null: none). */
export interface WalkStep {
  workflowPath: string[];
  nodeId: string;
  port: string | null;
}

export interface JobRow {
  id: string;
  runId: string;
  libraryId: string;
  fileId: string | null;
  path: string;
  workflowId: string;
  workflowVersion: number;
  dryRun: boolean;
  /** Dry runs only: encode, verify and measure for real, then stop before the first write. */
  testEncode: boolean;
  state: JobState;
  paused: boolean;
  priority: number;
  lane: Lane | null;
  attempt: number;
  requeues: number;
  /** The label of the slot that ran the encode; null before one did. */
  encodedOn: string | null;
  /** GPU ids this job's encode already failed on; a retry clears it. */
  failedGpus: string[];
  progress: JobProgress | null;
  reason: string | null;
  /** Why a `failed` job failed (null for any other state, and for failures recorded before migration 0018). */
  failureCode: FailureCode | null;
  /** What the Jobs list shows for the file, read when the job was queued; null for older jobs. */
  media: StoredJobMedia | null;
  replaceJournal: ReplaceJournal | null;
  restoreJournal: RestoreJournal | null;
  /** The path the walk took (partial up to the failing node on a walk failure); null before. */
  walkPath: WalkStep[] | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** One file move of a restore (or its undo), in the order they run. */
export interface RestoreMove {
  from: string;
  to: string;
  role: 'output' | 'original' | 'sidecar';
  /**
   * The fingerprint key of the file at `from` when the move was planned, so a rollback can tell
   * Transcoda's file from one another program put there meanwhile. Absent in older journals.
   */
  key?: string;
}

/**
 * A restore in flight, kept on the job like the replace journal: the moves and how many are done,
 * so the start-up sweep can roll back a restore a crash cut short.
 */
export interface RestoreJournal {
  direction: 'restore' | 'undo';
  restoreId: string;
  libraryRoot: string;
  moves: RestoreMove[];
  /** The index of the first move not yet done. */
  next: number;
}

export type JobInsert = Pick<
  JobRow,
  | 'id'
  | 'runId'
  | 'libraryId'
  | 'fileId'
  | 'path'
  | 'workflowId'
  | 'workflowVersion'
  | 'dryRun'
  | 'testEncode'
  | 'state'
  | 'priority'
> & { reason?: string | null; media?: StoredJobMedia | null };

export type JobPatch = Partial<
  Pick<
    JobRow,
    | 'state'
    | 'paused'
    | 'lane'
    | 'attempt'
    | 'requeues'
    | 'encodedOn'
    | 'failedGpus'
    | 'progress'
    | 'reason'
    | 'failureCode'
    | 'replaceJournal'
    | 'restoreJournal'
    | 'walkPath'
    | 'startedAt'
    | 'finishedAt'
    | 'fileId'
    | 'workflowVersion'
  >
>;

export interface DbJob {
  id: string;
  run_id: string;
  library_id: string;
  file_id: string | null;
  path: string;
  workflow_id: string;
  workflow_version: number;
  dry_run: number;
  test_encode: number;
  state: JobState;
  paused: number;
  priority: number;
  lane: Lane | null;
  attempt: number;
  requeues: number;
  encoded_on: string | null;
  failed_gpus: string;
  progress: string | null;
  reason: string | null;
  failure_code: FailureCode | null;
  media: string | null;
  replace_journal: string | null;
  restore_journal: string | null;
  walk_path: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export const parseJson = <T>(s: string | null): T | null =>
  s === null ? null : (JSON.parse(s) as T);
/** A string list (GPU ids, warnings, problems) that survives a corrupt cell: one bad row must not break every job read. */
export const parseStringList = (s: string): string[] => {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const MEDIA_KINDS: readonly unknown[] = ['movie', 'episode', 'unknown'];
const MEDIA_SOURCES: readonly unknown[] = ['sidecar', 'filename'];
const isIntOrNull = (v: unknown): boolean => v === null || Number.isInteger(v);
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

/** Whether a parsed cell has the shape of StoredJobMedia (the list's output schema checks it too). */
function isStoredMedia(v: unknown): v is StoredJobMedia {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    MEDIA_KINDS.includes(m.kind) &&
    MEDIA_SOURCES.includes(m.source) &&
    typeof m.title === 'string' &&
    m.title !== '' &&
    isIntOrNull(m.year) &&
    isIntOrNull(m.season) &&
    isIntOrNull(m.episode) &&
    isStringOrNull(m.episodeTitle) &&
    isStringOrNull(m.posterPath) &&
    (m.showPosterPath === undefined || isStringOrNull(m.showPosterPath))
  );
}

/**
 * The stored media; a corrupt or wrong-shaped cell reads as none, so one bad row cannot break
 * every job read (the list then parses the file name).
 */
export const parseMedia = (s: string | null): StoredJobMedia | null => {
  if (s === null) return null;
  try {
    const v: unknown = JSON.parse(s);
    return isStoredMedia(v) ? v : null;
  } catch {
    return null;
  }
};
export const toJson = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
export const ACTIVE_SQL = ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(',');
export const FINAL_SQL = FINAL_JOB_STATES.map((s) => `'${s}'`).join(',');

export const toJob = (r: DbJob): JobRow => ({
  id: r.id,
  runId: r.run_id,
  libraryId: r.library_id,
  fileId: r.file_id,
  path: r.path,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  dryRun: r.dry_run !== 0,
  testEncode: r.test_encode !== 0,
  state: r.state,
  paused: r.paused !== 0,
  priority: r.priority,
  lane: r.lane,
  attempt: r.attempt,
  requeues: r.requeues,
  encodedOn: r.encoded_on,
  failedGpus: parseStringList(r.failed_gpus),
  progress: parseJson<JobProgress>(r.progress),
  reason: r.reason,
  failureCode: r.failure_code,
  media: parseMedia(r.media),
  replaceJournal: parseJson<ReplaceJournal>(r.replace_journal),
  restoreJournal: parseJson<RestoreJournal>(r.restore_journal),
  walkPath: parseJson<WalkStep[]>(r.walk_path),
  queuedAt: r.queued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
});
