import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors, pickErrors } from '../errors.ts';
import { JobsQueueOutputSchema } from '../schemas/jobs.ts';
import {
  RunDetailSchema,
  RunIdInputSchema,
  RunProcessAgainInputSchema,
  RunsListInputSchema,
  RunsListOutputSchema,
} from '../schemas/runs.ts';

const tags = ['runs'];

export const runs = {
  list: oc
    .route({ method: 'GET', path: '/runs', tags, summary: 'Recent runs, newest first' })
    .errors(authedErrors)
    .input(RunsListInputSchema)
    .output(RunsListOutputSchema),
  get: oc
    .route({ method: 'GET', path: '/runs/{id}', tags, summary: 'A run with counts and files' })
    .errors({ ...authedErrors, ...pickErrors('NOT_FOUND') })
    .input(RunIdInputSchema)
    .output(RunDetailSchema),
  processAgain: oc
    .route({
      method: 'POST',
      path: '/runs/{id}/process-again',
      tags,
      summary: "Queue a run's already-processed files again, with force, as a new run",
      description:
        "A person's session only. A real run uses the active version (a dry run of the newest when none is active); dryRun plans the run's own version. NOT_FOUND when the run has no already-processed files.",
    })
    .errors({
      ...mutationErrors,
      ...pickErrors('PATH_REJECTED', 'NOT_FOUND', 'WORKFLOW_INVALID'),
    })
    .input(RunProcessAgainInputSchema)
    .output(JobsQueueOutputSchema),
};
