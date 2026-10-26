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
