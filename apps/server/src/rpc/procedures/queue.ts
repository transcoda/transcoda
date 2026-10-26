import type { QueueStatus } from '@transcoda/contract';
import type { EngineService } from '../../engine/engine.ts';
import { os, requireScope } from '../middleware.ts';

function status(engine: EngineService): QueueStatus {
  const { paused, lanes, encodeSlots, preparing } = engine.scheduler.status();
  return { paused, lanes, encodeSlots, preparing };
}

export const get = os.queue.status
  .use(requireScope('read'))
  .handler(({ context }) => status(context.deps.engine));

export const pause = os.queue.pause.use(requireScope('jobs:manage')).handler(({ context }) => {
  context.deps.engine.scheduler.pauseQueue();
  return status(context.deps.engine);
});

export const resume = os.queue.resume.use(requireScope('jobs:manage')).handler(({ context }) => {
  context.deps.engine.scheduler.resumeQueue();
  return status(context.deps.engine);
});
