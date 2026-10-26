import { oc } from '@orpc/contract';
import { authedErrors, pickErrors } from '../errors.ts';
import {
  RunDetailSchema,
  RunIdInputSchema,
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
};
