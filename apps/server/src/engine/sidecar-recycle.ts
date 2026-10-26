// After a replace: the subtitle files that were embedded move to the recycle folder.
import { basename, dirname } from 'node:path';
import type { BuildModel } from '@transcoda/sdk';
import type { RecycledRow } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { extraInputOf, isExtraStream } from './build-model.ts';
import { errorCode, type FsOps, renameNoClobber, syncDirs } from './fs-ops.ts';
import { isWithin } from './paths.ts';
import { recyclePathFor } from './replace.ts';

/** The error's code (`ENOENT`) when it has one: a system error's message names full paths. */
const why = (err: unknown): string =>
  errorCode(err) ?? (err instanceof Error ? err.message : String(err));

/**
 * Moves each extra input with `afterReplace: 'recycle'` whose stream was kept (so it is in the
 * replaced file) to `recyclePathFor(recycleFolder, libraryRoot, path, n)` with the first free `n`,
 * without clobbering, and records it like a recycled original. A file planned but dropped (the
 * container could not hold it) stays. Never deletes a file; a failure is a problem string
 * (`subtitle file Show.de.srt could not be recycled: <why>`), never a throw.
 *
 * The move is `renameNoClobber`: where hard links work it links the file into the recycle folder,
 * then unlinks the old name. If that unlink fails, the file is left under both names (one inode,
 * a stray hard link beside the video) and the problem is reported; the recycled copy is not
 * recorded then, and nothing removes the stray name automatically.
 */
export async function recycleSidecars(
  input: {
    model: BuildModel;
    jobId: string;
    libraryId: string;
    libraryRoot: string;
    recycleFolder: string;
  },
  deps: { fs: FsOps; recordRecycled(row: RecycledRow): void; now(): Date; log: Logger },
): Promise<string[]> {
  const { model } = input;
  const { fs, log } = deps;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of model.streams) {
    if (!isExtraStream(s) || !s.keep) continue;
    const extra = extraInputOf(model, s);
    if (extra === null || extra.afterReplace !== 'recycle' || seen.has(extra.path)) continue;
    seen.add(extra.path);
    const path = extra.path;
    try {
      // Only a realpath inside the library: a parent directory swapped for a symlink since the
      // build would move a file from elsewhere (lstat only checks the last component).
      if (
        path === input.libraryRoot ||
        !isWithin(path, input.libraryRoot) ||
        (await fs.realpath(path)) !== path
      ) {
        throw new Error('its path is not a real path in the library');
      }
      const st = await fs.lstat(path);
      if (!st.isFile()) throw new Error('it is no longer a regular file');
      let n = 0;
      let dest = recyclePathFor(input.recycleFolder, input.libraryRoot, path);
      while (await fs.exists(dest)) {
        n += 1;
        dest = recyclePathFor(input.recycleFolder, input.libraryRoot, path, n);
      }
      await fs.mkdir(dirname(dest));
      await renameNoClobber(fs, path, dest);
      // Recorded as soon as it is there, so retention prunes it even if the sync below fails.
      deps.recordRecycled({
        path: dest,
        libraryId: input.libraryId,
        jobId: input.jobId,
        sizeBytes: st.size,
        recycledAt: deps.now().toISOString(),
      });
      try {
        await syncDirs(fs, [dirname(dest), dirname(path)], log);
      } catch (err) {
        problems.push(
          `subtitle file ${basename(path)} was moved to the recycle folder but the folder sync failed: ${why(err)}`,
        );
      }
    } catch (err) {
      const problem = `subtitle file ${basename(path)} could not be recycled: ${why(err)}`;
      log.warn({
        msg: 'could not recycle a subtitle file',
        job: input.jobId,
        file: basename(path),
      });
      problems.push(problem);
    }
  }
  return problems;
}
