import type { Library } from '@transcoda/contract';
import type { Database } from '../../db/open.ts';
import {
  clearMigrationNotices,
  findLibrary,
  type LibraryRow,
  listLibraries,
  listMigrationNotices,
} from '../../db/repos/libraries.ts';
import { findFeeder, type LibraryNamer, listInactiveNamers } from '../../db/repos/workflows.ts';
import { os, requireScope } from '../middleware.ts';

// Reads need `read`; changes need `jobs:manage` (no new scopes).

/**
 * `feeds`: the active workflow whose Library input names the library. `namedByInactive`: with no
 * feeder, the workflows whose newest (not active) version names it. `namers` is
 * listInactiveNamers, read once for a whole list.
 */
function toLibrary(
  db: Database,
  { deletedAt: _deleted, ...library }: LibraryRow,
  namers: Map<string, LibraryNamer[]> = listInactiveNamers(db),
): Library {
  const feeds = findFeeder(db, library.id);
  return { ...library, feeds, namedByInactive: feeds ? [] : (namers.get(library.id) ?? []) };
}

/** The keys of `o` whose value is not undefined (inputs are exact-optional downstream). */
function defined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export const list = os.libraries.list.use(requireScope('read')).handler(({ context }) => {
  const { db } = context.deps;
  const namers = listInactiveNamers(db);
  return {
    libraries: listLibraries(db).map((l) => toLibrary(db, l, namers)),
    notices: listMigrationNotices(db),
    clock: { now: context.deps.now().toISOString(), timeZone: context.deps.engine.timeZone },
  };
});

/** The upgrade notices (migration 0008) are read once and dismissed for everyone. */
export const dismissNotices = os.libraries.dismissNotices
  .use(requireScope('jobs:manage'))
  .handler(({ context }) => {
    clearMigrationNotices(context.deps.db);
    return { ok: true as const };
  });

export const get = os.libraries.get
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const library = findLibrary(context.deps.db, input.id);
    if (!library || library.deletedAt !== null) throw errors.NOT_FOUND();
    return toLibrary(context.deps.db, library);
  });

export const browse = os.libraries.browse
  .use(requireScope('read'))
  .handler(async ({ context, input, errors }) => {
    const result = await context.deps.engine.queue.browse(input.id, input.path);
    if (result === 'not-found') throw errors.NOT_FOUND();
    if ('kind' in result) {
      throw errors.PATH_REJECTED({ data: { path: input.path, reason: result.reason } });
    }
    return result;
  });

export const create = os.libraries.create
  .use(requireScope('jobs:manage'))
  .handler(async ({ context, input, errors }) => {
    const { name, path, defaultWorkflowId: _removed, ...options } = input;
    const result = await context.deps.engine.queue.createLibrary({
      name,
      path,
      ...defined(options),
    });
    if (!('kind' in result)) return toLibrary(context.deps.db, result);
    switch (result.kind) {
      case 'path-invalid':
        throw errors.LIBRARY_PATH_INVALID({ data: { reason: result.reason } });
      case 'overlaps':
        throw errors.LIBRARY_PATH_INVALID({
          data: { reason: `overlaps library "${result.other.name}"` },
        });
    }
  });

export const update = os.libraries.update
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    const { id, defaultWorkflowId: _removed, ...patch } = input;
    const result = context.deps.engine.queue.updateLibrary(id, defined(patch));
    if (result === null) throw errors.NOT_FOUND();
    if ('kind' in result) {
      throw errors.LIBRARY_PATH_INVALID({ data: { reason: result.reason } });
    }
    return toLibrary(context.deps.db, result);
  });

export const remove = os.libraries.delete
  .use(requireScope('jobs:manage'))
  .handler(({ context, input, errors }) => {
    const result = context.deps.engine.queue.deleteLibrary(input.id);
    if (result === 'not-found') throw errors.NOT_FOUND();
    if (result === 'busy') throw errors.LIBRARY_BUSY();
    return { ok: true as const };
  });
