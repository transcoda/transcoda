import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { OkOutputSchema } from '../schemas/auth.ts';
import {
  JobDetailSchema,
  JobHistoryOutputSchema,
  JobIdInputSchema,
  JobLogOutputSchema,
  JobStatsInputSchema,
  JobStatsOutputSchema,
  JobsListInputSchema,
  JobsListOutputSchema,
  JobsQueueInputSchema,
  JobsQueueOutputSchema,
  JobsRetryFailedOutputSchema,
} from '../schemas/jobs.ts';

const tags = ['jobs'];
const controlErrors = { ...mutationErrors, ...pickErrors('NOT_FOUND', 'JOB_NOT_ACTIVE') };

export const jobs = {
  queue: oc
    .route({
      method: 'POST',
      path: '/jobs',
      tags,
      summary: 'Queue a file or folder (one run, one job per media file)',
      description: 'Needs jobs:create, or plan for a dry run.',
    })
    .errors({
      ...mutationErrors,
      ...pickErrors('PATH_REJECTED', 'NOT_FOUND', 'WORKFLOW_INVALID', 'NO_FEEDING_WORKFLOW'),
    })
    .input(JobsQueueInputSchema)
    .output(JobsQueueOutputSchema),
  list: oc
    .route({ method: 'GET', path: '/jobs', tags, summary: 'List jobs, active first' })
    .errors(authedErrors)
    .input(JobsListInputSchema)
    .output(JobsListOutputSchema),
  stats: oc
    .route({ method: 'GET', path: '/jobs/stats', tags, summary: 'Totals since a time' })
    .errors(authedErrors)
    .input(JobStatsInputSchema)
    .output(JobStatsOutputSchema),
  history: oc
    .route({
      method: 'GET',
      path: '/jobs/history',
      tags,
      summary: "Last 7 days and all-time totals, in the server's local days",
    })
    .errors(authedErrors)
    .output(JobHistoryOutputSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/jobs/{id}',
      tags,
      summary: 'A job with its trace, result, probe, plan and graph',
    })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(JobIdInputSchema)
    .output(JobDetailSchema),
  log: oc
    .route({ method: 'GET', path: '/jobs/{id}/log', tags, summary: 'The tail of the ffmpeg log' })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(JobIdInputSchema)
    .output(JobLogOutputSchema),
  pause: oc
    .route({ method: 'POST', path: '/jobs/{id}/pause', tags, summary: 'Pause a job' })
    .errors(controlErrors)
    .input(JobIdInputSchema)
    .output(OkOutputSchema),
  resume: oc
    .route({ method: 'POST', path: '/jobs/{id}/resume', tags, summary: 'Resume a paused job' })
    .errors(controlErrors)
    .input(JobIdInputSchema)
    .output(OkOutputSchema),
  retryFailed: oc
    .route({
      method: 'POST',
      path: '/jobs/retry-failed',
      tags,
      summary: 'Queue every failed job again (one more attempt each)',
    })
    .errors(mutationErrors)
    .output(JobsRetryFailedOutputSchema),
  cancel: oc
    .route({ method: 'POST', path: '/jobs/{id}/cancel', tags, summary: 'Cancel a job' })
    .errors(controlErrors)
    .input(JobIdInputSchema)
    .output(OkOutputSchema),
  deleteTestOutput: oc
    .route({
      method: 'DELETE',
      path: '/jobs/{id}/test-output',
      tags,
      summary: "Delete a test-encode dry run's kept output",
      description: "A person's session only.",
    })
    .errors({ ...mutationErrors, ...pickErrors('NOT_FOUND') })
    .input(JobIdInputSchema)
    .output(OkOutputSchema),
};
