import { os, requireHumanSessionWith, requireScope } from '../middleware.ts';

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

export const list = os.recycle.list
  .use(requireScope('read'))
  .handler(async ({ context, input, errors }) => {
    const out = await context.deps.engine.recycleList(input.libraryId);
    if (input.libraryId !== undefined && out.library === null) throw errors.NOT_FOUND();
    const { library } = out;
    return {
      libraries: out.libraries,
      library: library && {
        id: library.libraryId,
        name: library.name,
        folder: library.folder,
        totalBytes: library.totalBytes,
        freeBytes: library.freeBytes,
        retentionDays: library.retentionDays,
        entries: library.entries.map((e) => ({
          path: e.path,
          relativePath: e.relativePath,
          kind: e.kind,
          sizeBytes: e.sizeBytes,
          jobId: e.jobId,
          recycledAt: e.recycledAt,
          deletesAt: e.deletesAt,
        })),
      },
    };
  });

const DELETE_REFUSAL = 'Deleting from the recycle folder is a UI action';

export const remove = os.recycle.delete
  .use(requireHumanSessionWith(DELETE_REFUSAL))
  .handler(async ({ context, input, errors }) => {
    const result = await context.deps.engine.deleteRecycled(input.path);
    switch (result.kind) {
      case 'deleted':
        return { bytes: result.bytes };
      case 'not-found':
        throw errors.NOT_FOUND();
      case 'refused':
        throw errors.RECYCLE_REFUSED({ data: { reason: result.reason } });
    }
  });

export const empty = os.recycle.empty
  .use(requireHumanSessionWith(DELETE_REFUSAL))
  .handler(async ({ context, input, errors }) => {
    const out = await context.deps.engine.emptyRecycle(input.libraryId, input.throughRecycledAt);
    if (out === null) throw errors.NOT_FOUND();
    return out;
  });
