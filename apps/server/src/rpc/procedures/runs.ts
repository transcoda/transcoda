import { os, requireScope } from '../middleware.ts';

export const list = os.runs.list
  .use(requireScope('read'))
  .handler(({ context, input }) => ({ runs: context.deps.engine.queue.listRuns(input.limit) }));

export const get = os.runs.get.use(requireScope('read')).handler(({ context, input, errors }) => {
  const run = context.deps.engine.queue.runSummary(input.id);
  if (!run) throw errors.NOT_FOUND();
  return run;
});
