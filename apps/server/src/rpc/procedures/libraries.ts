import type {
  JobProbe,
  Library,
  LibraryFile,
  LibraryFileDetail,
  PosterRef,
} from '@transcoda/contract';
import type { ProbeResult } from '@transcoda/sdk';
import type { Database } from '../../db/open.ts';
import { findJobProbe, findJobResult, type JobListRow } from '../../db/repos/jobs.ts';
import {
  clearMigrationNotices,
  findLibrary,
  type LibraryRow,
  listLibraries,
  listMigrationNotices,
} from '../../db/repos/libraries.ts';
import {
  countListedFiles,
  findFileProbe,
  findLibraryFile,
  type LibraryFileRow,
  listFileJobs,
  listLibraryFiles,
  listSeasons,
  listTitles,
  parseShowKey,
  type PosterRef as RepoPosterRef,
  resolveShowSelection,
} from '../../db/repos/library-files.ts';
import { findFeeder, type LibraryNamer, listInactiveNamers } from '../../db/repos/workflows.ts';
import { jobProbeOf } from '../../engine/media/probe.ts';
import { closedLibraries, runHoursHold } from '../../engine/run-hours.ts';
import type { AppDeps } from '../context.ts';
import { os, requireScope } from '../middleware.ts';
import { toJob } from './jobs.ts';

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

/** The server's clock for a read: run hours are in its time zone. */
function serverClock(deps: { now(): Date; engine: { timeZone: string } }) {
  return { now: deps.now().toISOString(), timeZone: deps.engine.timeZone };
}

export const list = os.libraries.list.use(requireScope('read')).handler(({ context }) => {
  const { db } = context.deps;
  const namers = listInactiveNamers(db);
  return {
    libraries: listLibraries(db).map((l) => toLibrary(db, l, namers)),
    notices: listMigrationNotices(db),
    clock: serverClock(context.deps),
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
    return {
      ...toLibrary(context.deps.db, library),
      clock: serverClock(context.deps),
      fileCount: countListedFiles(context.deps.db, library.id),
    };
  });

export const browse = os.libraries.browse
  .use(requireScope('read'))
  .handler(async ({ context, input, errors }) => {
    const result = await context.deps.engine.queue.browse(input.id, input.path);
    if (result === 'not-found') throw errors.NOT_FOUND();
    if ('kind' in result && result.kind === 'library-unreachable') {
      throw errors.LIBRARY_UNREACHABLE({ data: { path: result.path } });
    }
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

// ---- the library browser: shows, seasons, movies and files with their latest job ----

/** The job rows as the API shows them, each with what holds it back for its library's run hours. */
function jobMapper(deps: AppDeps): (row: JobListRow) => ReturnType<typeof toJob> {
  const { db, engine } = deps;
  const closed = closedLibraries(db, deps.now(), engine.timeZone);
  return (row) => toJob({ ...row, heldByRunHours: runHoursHold(row, closed, engine.timeZone) });
}

/**
 * The repo's poster (job id + stored media) as the contract's: `poster` is whether an image
 * exists (the show's own for `of: 'show'`), never its path.
 */
function toPoster(ref: RepoPosterRef | null): PosterRef | null {
  if (!ref) return null;
  const { posterPath, showPosterPath, ...fields } = ref.media;
  if (ref.of === 'show') {
    return {
      id: ref.jobId,
      media: { ...fields, poster: typeof showPosterPath === 'string' },
      of: 'show',
    };
  }
  return { id: ref.jobId, media: { ...fields, poster: posterPath !== null } };
}

function toFile(row: LibraryFileRow, job: ReturnType<typeof jobMapper>): LibraryFile {
  return {
    id: row.id,
    path: row.path,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    originalBytes: row.originalBytes,
    mtime: row.mtime,
    gone: row.goneAt !== null,
    poster: toPoster(row.mediaJobId === null ? null : { jobId: row.mediaJobId, media: row.media }),
    latest: job(row.latest),
  };
}

function liveLibrary(db: Database, id: string): boolean {
  const library = findLibrary(db, id);
  return library !== null && library.deletedAt === null;
}

export const titles = os.libraries.titles
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const { db } = context.deps;
    if (!liveLibrary(db, input.id)) throw errors.NOT_FOUND();
    const job = jobMapper(context.deps);
    const { items, total } = listTitles(db, {
      libraryId: input.id,
      ...(input.search !== undefined && { search: input.search }),
      offset: input.offset,
      limit: input.limit,
    });
    return {
      items: items.map((item) =>
        item.type === 'show'
          ? { ...item, poster: toPoster(item.poster) }
          : {
              type: 'movie' as const,
              fileId: item.fileId,
              poster: toPoster(item.poster),
              latest: job(item.latest),
            },
      ),
      total,
    };
  });

export const seasons = os.libraries.seasons
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const { db } = context.deps;
    const show = parseShowKey(input.show);
    if (!liveLibrary(db, input.id) || !show) throw errors.NOT_FOUND();
    const groups = listSeasons(db, input.id, show);
    if (groups.length === 0) throw errors.NOT_FOUND();
    return {
      title: show.title,
      year: show.year,
      seasons: groups.map((g) => ({ ...g, poster: toPoster(g.poster) })),
    };
  });

export const files = os.libraries.files
  .use(requireScope('read'))
  .handler(({ context, input, errors }) => {
    const { db } = context.deps;
    if (!liveLibrary(db, input.id)) throw errors.NOT_FOUND();
    // A key naming a show with no episodes here is as unknown as one that does not parse.
    const sel =
      input.show === undefined
        ? null
        : resolveShowSelection(db, input.id, input.show, input.season);
    if (input.show !== undefined && sel === null) throw errors.NOT_FOUND();
    const job = jobMapper(context.deps);
    const { rows, total } = listLibraryFiles(db, {
      libraryId: input.id,
      ...(sel !== null && { show: sel.show }),
      ...(sel?.season !== undefined && { season: sel.season }),
      ...(input.search !== undefined && { search: input.search }),
      sort: input.sort,
      desc: input.desc,
      offset: input.offset,
      limit: input.limit,
    });
    return { files: rows.map((r) => toFile(r, job)), total };
  });

export const file = os.libraries.file
  .use(requireScope('read'))
  .handler(({ context, input, errors }): LibraryFileDetail => {
    const { db } = context.deps;
    if (!liveLibrary(db, input.id)) throw errors.NOT_FOUND();
    const row = findLibraryFile(db, input.id, input.fileId);
    if (!row) throw errors.NOT_FOUND();
    const job = jobMapper(context.deps);
    const history = listFileJobs(db, row.id, {
      offset: input.jobsOffset,
      limit: input.jobsLimit,
    });
    // Replaced = the list's rule: the latest job replaced the file, no restore is in effect and
    // the file has not been seen since as something else.
    const result = findJobResult(db, row.latest.id);
    const replaced = row.replaced;
    // Stored as a JobProbe; the first builds stored the whole ProbeResult (with `raw`).
    const output = result?.outputProbe as JobProbe | ProbeResult | null | undefined;
    const own = findJobProbe(db, row.latest.id) as ProbeResult | null;
    const current = findFileProbe(db, row.id) as ProbeResult | null;
    const outputProbe = !output ? null : 'raw' in output ? jobProbeOf(output) : output;
    const fileProbe = current ? jobProbeOf(current) : null;
    return {
      file: toFile(row, job),
      showKey: row.showKey,
      season: row.season,
      // A replace from before output probes were kept has none: what the file is now is unknown,
      // and the file's stored probe is the original's.
      now: replaced ? outputProbe : fileProbe,
      before: replaced && own ? jobProbeOf(own) : null,
      jobs: history.jobs.map(job),
      jobsTotal: history.total,
    };
  });
