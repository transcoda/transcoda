import { oc } from '@orpc/contract';
import { authedErrors, mutationErrors } from '../errors.ts';
import { QueueStatusSchema } from '../schemas/queue.ts';

const tags = ['queue'];

export const queue = {
  status: oc
    .route({ method: 'GET', path: '/queue', tags, summary: 'Queue pause and lanes' })
    .errors(authedErrors)
    .output(QueueStatusSchema),
  pause: oc
    .route({ method: 'POST', path: '/queue/pause', tags, summary: 'Pause the queue (persisted)' })
    .errors(mutationErrors)
    .output(QueueStatusSchema),
  resume: oc
    .route({ method: 'POST', path: '/queue/resume', tags, summary: 'Resume the queue' })
    .errors(mutationErrors)
    .output(QueueStatusSchema),
};
