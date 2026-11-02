import { os, requireHumanSessionWith, requireScope } from '../middleware.ts';

export const list = os.runs.list
  .use(requireScope('read'))
  .handler(({ context, input }) => ({ runs: context.deps.engine.queue.listRuns(input.limit) }));

export const get = os.runs.get.use(requireScope('read')).handler(({ context, input, errors }) => {
  const run = context.deps.engine.queue.runSummary(input.id);
  if (!run) throw errors.NOT_FOUND();
  return run;
});

// Session-only ("Process again" on the run page): any API token is refused and no MCP tool wraps
// it; a token queues a file with force through jobs.queue instead.
export const processAgain = os.runs.processAgain
  .use(requireHumanSessionWith('Process again is a UI action'))
  .handler(async ({ context, input, errors }) => {
    const { queue } = context.deps.engine;
    const result = await queue.processAgain(input.id, {
      dryRun: input.dryRun,
      createdBy: context.auth.user.id,
    });
    switch (result.kind) {
      case 'queued':
        return {
          runId: result.run.id,
          jobIds: result.jobs.map((j) => j.id),
          dryRun: result.run.dryRun,
          note: result.run.note,
          workflowVersion: result.run.workflowVersion,
          testEncode: result.run.testEncode,
        };
      case 'run-missing':
        throw errors.NOT_FOUND();
      case 'nothing-to-process':
        throw errors.NOT_FOUND({ message: 'This run has no already-processed files' });
      case 'path-rejected': {
        const path = queue.runSummary(input.id)?.run.requestedPath ?? input.id;
        throw errors.PATH_REJECTED({ data: { path, reason: result.reason } });
      }
      case 'workflow-missing':
        throw errors.NOT_FOUND({ message: 'Workflow not found' });
      case 'version-missing':
        throw errors.NOT_FOUND({ message: 'Workflow version not found' });
      case 'workflow-invalid':
        throw errors.WORKFLOW_INVALID({ data: { issues: result.issues } });
      case 'no-feeding-workflow':
        // A run always names its workflow, so the library's feeder is never asked.
        throw new Error('no feeding workflow for a named workflow');
    }
  });
