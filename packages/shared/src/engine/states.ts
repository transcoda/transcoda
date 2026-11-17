import { z } from 'zod';

export const JOB_STATES = [
  'queued',
  'probing',
  'deciding',
  'building',
  'encoding',
  'verifying',
  'replacing',
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
  'cancelled',
  'dry_run',
  'skipped',
  'already_processed',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** queued … replacing */
export const ACTIVE_JOB_STATES: readonly JobState[] = JOB_STATES.slice(0, 7);
/**
 * queued … verifying: what "Cancel all" stops. A `replacing` job is left to finish: its cancel
 * cannot undo the write and would end it `done` anyway.
 */
export const CANCELLABLE_JOB_STATES: readonly JobState[] = JOB_STATES.slice(0, 6);
/** done … already_processed */
export const FINAL_JOB_STATES: readonly JobState[] = JOB_STATES.slice(7);
export const RUNNING_JOB_STATES: readonly JobState[] = [
  'probing',
  'deciding',
  'building',
  'encoding',
  'verifying',
  'replacing',
];

export function isFinalState(s: JobState): boolean {
  return FINAL_JOB_STATES.includes(s);
}

/**
 * Why a `failed` job failed, machine-readable (the job's `reason` stays the human sentence). A
 * bounded set: it is a Prometheus label (`transcoda_jobs_failed{reason}`).
 *
 * - `interrupted`: the server stopped mid-job (a second interruption, or a replace rolled back at start).
 * - `source_unreadable`: the source could not be read or probed.
 * - `source_changed`: the source changed (or moved) while the job ran.
 * - `encode`: ffmpeg failed, stalled or wrote the wrong output; rendering the command failed.
 * - `verify`: the encoded output failed its checks.
 * - `replace`: replacing the original, the move or copy of the output, or recovering a replace.
 * - `workflow`: the workflow is missing or invalid, a node failed, a plugin failed.
 * - `internal`: an unexpected internal error.
 */
export const FAILURE_CODES = [
  'interrupted',
  'source_unreadable',
  'source_changed',
  'encode',
  'verify',
  'replace',
  'workflow',
  'internal',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export const FailureCodeSchema = z.enum(FAILURE_CODES);

export const LANES = ['encode', 'quick'] as const;
export type Lane = (typeof LANES)[number];

export const JobStateSchema = z.enum(JOB_STATES);
export const LaneSchema = z.enum(LANES);

export const RUN_OUTCOME_KEYS = [
  'done',
  'nothing_to_do',
  'kept_original',
  'failed',
  'cancelled',
  'dry_run',
  'skipped',
  'already_processed',
  'queued',
  'in_progress',
] as const;
