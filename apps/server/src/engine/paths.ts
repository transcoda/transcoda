// Which paths the engine may touch: library roots (realpaths), the media allowlist, skip reasons.
import type { Stats } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { MEDIA_EXTENSIONS } from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import { type LibraryRow, listLibraries, trimSlash } from '../db/repos/libraries.ts';
import type { Fingerprint } from './fingerprint.ts';
import { errorCode, type FsOps, nodeFsOps } from './fs-ops.ts';
import { defaultRecycleFolder } from './recycle.ts';

/**
 * A sidecar subtitle larger than this is neither embedded nor copied for ffmpeg (real ones are
 * well under 1 MiB). Discovery skips it; the pipeline's copy refuses it.
 */
export const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

/** Extensions queued from a folder (lower case); everything else is ignored. Shared with the web. */
export { MEDIA_EXTENSIONS };

/** A file modified less than this many minutes ago may still be copied in: skipped. */
export const SETTLE_MINUTES = 3;

export type PathCheck =
  | {
      ok: true;
      realPath: string;
      /** The library, with `path` (and an existing `recycleFolder`) resolved to realpaths. */
      library: LibraryRow;
    }
  | {
      ok: false;
      reason:
        | 'outside library root'
        | 'not found'
        | 'unreadable'
        | 'symlink escapes root'
        | 'path too long';
    };

export type SkipReason =
  | 'still growing'
  | 'hardlinked'
  | 'unreadable'
  | 'not media'
  | 'outside library root'
  | 'symlink escapes root'
  | 'in recycle folder'
  | 'path too long';

/** The replace's tmp file beside an original: `.transcoda-<job>.tmp`. */
const REPLACE_TMP = /^\.transcoda-.*\.tmp$/;

/** `p` is `root` or below it (both absolute and without a trailing slash). */
export function isWithin(p: string, root: string): boolean {
  return p === root || p.startsWith(root === sep ? sep : `${root}${sep}`);
}

export function isMediaFile(path: string): boolean {
  return (MEDIA_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const DENIED = new Set(['EACCES', 'EPERM']);

async function realpathOrNull(fs: FsOps, p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Where `path` really is, and the library it belongs to. Both sides are resolved with `realpath`
 * (a root stored or given through a symlink, or with a trailing slash, still matches). A path that
 * lies (as written) under a library root must resolve under that same root: a symlink anywhere
 * along it that leads out — even into another library — is `symlink escapes root`. A path written
 * outside every root is accepted when it resolves into one (a symlinked alias of the root).
 * Soft-deleted libraries and roots that cannot be resolved (an unmounted share) hold nothing.
 */
export async function checkPath(
  db: Database,
  path: string,
  fs: FsOps = nodeFsOps,
): Promise<PathCheck> {
  const abs = resolve(path);
  let real: string;
  try {
    await fs.lstat(abs);
    real = await fs.realpath(abs);
  } catch (err) {
    const code = errorCode(err);
    if (code !== undefined && MISSING.has(code)) return { ok: false, reason: 'not found' };
    if (code !== undefined && DENIED.has(code)) return { ok: false, reason: 'unreadable' };
    if (code === 'ELOOP') return { ok: false, reason: 'symlink escapes root' };
    if (code === 'ENAMETOOLONG') return { ok: false, reason: 'path too long' };
    throw err;
  }

  type Root = { library: LibraryRow; lexical: string; real: string };
  const roots: Root[] = [];
  for (const library of listLibraries(db)) {
    const lexical = trimSlash(resolve(library.path));
    const realRoot = await realpathOrNull(fs, lexical);
    if (realRoot !== null) roots.push({ library, lexical, real: realRoot });
  }
  /** The root with the longest match (0: no match). */
  const deepest = (matchLength: (r: Root) => number): Root | null => {
    let best: Root | null = null;
    let bestLength = 0;
    for (const r of roots) {
      const n = matchLength(r);
      if (n > bestLength) {
        best = r;
        bestLength = n;
      }
    }
    return best;
  };
  const under = (p: string, root: string): number => (isWithin(p, root) ? root.length : 0);

  // As written: the deepest root (by its stored or its real path) the path sits under.
  const owner = deepest((r) => Math.max(under(abs, r.lexical), under(abs, r.real)));
  const found = owner
    ? isWithin(real, owner.real)
      ? owner
      : null
    : deepest((r) => under(real, r.real));
  if (!found) {
    return { ok: false, reason: owner ? 'symlink escapes root' : 'outside library root' };
  }
  const { library } = found;
  const recycleFolder =
    library.recycleFolder === null
      ? null
      : ((await realpathOrNull(fs, resolve(found.real, library.recycleFolder))) ??
        trimSlash(resolve(found.real, library.recycleFolder)));
  return { ok: true, realPath: real, library: { ...library, path: found.real, recycleFolder } };
}

/**
 * Engine litter that is never media: anything under the library's recycle folder (the default
 * `<root>/.transcoda-recycle` and a configured one) or a replace tmp `.transcoda-<job>.tmp`.
 */
export function isRecycleOrTemp(path: string, library: LibraryRow): boolean {
  const p = resolve(path);
  const root = trimSlash(resolve(library.path));
  const folders = [defaultRecycleFolder(root)];
  if (library.recycleFolder !== null) folders.push(trimSlash(resolve(root, library.recycleFolder)));
  return folders.some((f) => isWithin(p, f)) || REPLACE_TMP.test(basename(p));
}

/**
 * Media files under `dir` (recursive), sorted: allowlisted extensions only, recycle folders and
 * tmp files skipped. Symlinked directories are not followed (no loops, no escapes); a symlinked
 * file is listed as found, and the caller checks where it leads. An unreadable subfolder is left
 * out; an unreadable `dir` throws.
 */
export async function listMediaFiles(
  dir: string,
  library: LibraryRow,
  fs: FsOps = nodeFsOps,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, top: boolean): Promise<void> => {
    let entries: Awaited<ReturnType<FsOps['readdir']>>;
    try {
      entries = await fs.readdir(d);
    } catch (err) {
      const code = errorCode(err);
      if (!top && code !== undefined && (DENIED.has(code) || MISSING.has(code))) return;
      throw err;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (isRecycleOrTemp(full, library)) continue;
      if (e.isDirectory()) await walk(full, false);
      else if ((e.isFile() || e.isSymbolicLink()) && isMediaFile(full)) out.push(full);
    }
  };
  await walk(resolve(dir), true);
  return out.sort();
}

/**
 * Why a file found in a library is not processed now, or null. `still growing`: modified within
 * the last `settleMinutes` (0 turns the check off); `hardlinked`: more than one link while the
 * library does not process hardlinked files (the replace would split the links).
 */
export function skipReasonFor(
  fp: Fingerprint,
  stat: Stats,
  library: LibraryRow,
  now: Date,
  settleMinutes: number,
): SkipReason | null {
  if (!stat.isFile()) return 'not media';
  if (settleMinutes > 0 && now.getTime() - fp.mtimeMs < settleMinutes * 60_000) {
    return 'still growing';
  }
  if (fp.nlink > 1 && !library.processHardlinked) return 'hardlinked';
  return null;
}
