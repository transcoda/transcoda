import { eventIterator, oc } from '@orpc/contract';
import { authedErrors } from '../errors.ts';
import { EngineEventSchema } from '../schemas/events.ts';

export const events = {
  subscribe: oc
    .route({
      method: 'GET',
      path: '/events',
      tags: ['events'],
      summary: 'Engine events (server-sent events)',
      description:
        'First a queue.changed snapshot, then job, trace, run and queue changes, a ping every 30 s, and resync when events were dropped.',
    })
    .errors(authedErrors)
    .output(eventIterator(EngineEventSchema)),
};
