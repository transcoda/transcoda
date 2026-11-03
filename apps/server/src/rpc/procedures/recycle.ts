import { os, requireHumanSessionWith } from '../middleware.ts';

// Session-only (Restore on the job page and the Recycle page): any API token is refused and no MCP
// tool wraps it, since it moves files in the library.
export const restore = os.recycle.restore
  .use(requireHumanSessionWith('Restore is a UI action'))
  .handler(async ({ context, input, errors }) => {
    const result = await context.deps.engine.restoreRecycled({
      path: input.path,
      userId: context.auth.user.id,
    });
    switch (result.kind) {
      case 'restored':
      case 'undone':
        return { jobId: result.jobId, direction: result.kind, notRestored: result.notRestored };
      case 'not-found':
        throw errors.NOT_FOUND();
      case 'refused':
      case 'failed':
        throw errors.RECYCLE_REFUSED({ data: { reason: result.reason } });
    }
  });
