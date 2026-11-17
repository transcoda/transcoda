// What a queued file is (title, year, episode, poster): its name, overlaid with the Kodi/Jellyfin
// sidecars beside it (`.nfo` files and poster images). Read only, best effort, never throws.
import { basename, dirname, extname, join } from 'node:path';
import { isSeasonFolder, parseFileName, type StoredJobMedia } from '@transcoda/shared';
import type { Logger } from '../logger.ts';
import { type FsOps, why } from './fs-ops.ts';
import { type Nfo, type NfoRoot, readNfo } from './nfo.ts';
import { isWithin } from './paths.ts';

/** A `.nfo` larger than this (1 MiB) is not read. */
export const NFO_MAX_BYTES = 1_048_576;
/** Poster image extensions, in the order they are tried. */
export const POSTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

export interface MediaResolver {
  /** Never throws. `path` and `libraryRoot` are real, absolute paths. */
  resolve(path: string, libraryRoot: string): Promise<StoredJobMedia>;
}

/**
 * A folder's entries: the real names, and lower-cased name → first real name for a
 * case-insensitive fallback; null when it cannot be listed.
 */
type Listing = { names: Set<string>; byLower: Map<string, string> } | null;

const withRoot = (nfo: Nfo | null, want: NfoRoot): Nfo | null => (nfo?.root === want ? nfo : null);

/**
 * One resolver per queue call: it caches directory listings, parsed tvshow.nfo and the show
 * poster by folder.
 */
export function createMediaResolver(deps: { fs: FsOps; log: Logger }): MediaResolver {
  const { fs, log } = deps;
  const listings = new Map<string, Promise<Listing>>();
  const shows = new Map<string, Promise<Nfo | null>>();
  const showPosters = new Map<string, Promise<string | null>>();

  const debug = (msg: string, path: string, err: unknown): void => {
    log.debug?.({ msg, file: basename(path), why: why(err) });
  };

  /** Folders inside the root only: never the root's parent or anything else outside. */
  const list = (dir: string, root: string): Promise<Listing> => {
    if (!isWithin(dir, root)) return Promise.resolve(null);
    let cached = listings.get(dir);
    if (cached === undefined) {
      cached = (async () => {
        try {
          const names = new Set<string>();
          const byLower = new Map<string, string>();
          for (const e of await fs.readdir(dir)) {
            names.add(e.name);
            const key = e.name.toLowerCase();
            if (!byLower.has(key)) byLower.set(key, e.name);
          }
          return { names, byLower };
        } catch (err) {
          debug('could not list a folder for media info', dir, err);
          return null;
        }
      })();
      listings.set(dir, cached);
    }
    return cached;
  };

  /**
   * The real path of `name` in `dir`: the exact name, else (unless `exactOnly`) a
   * case-insensitive match; or null.
   */
  const find = async (
    dir: string,
    name: string,
    root: string,
    exactOnly = false,
  ): Promise<string | null> => {
    const listing = await list(dir, root);
    if (listing === null) return null;
    const real = listing.names.has(name)
      ? name
      : exactOnly
        ? undefined
        : listing.byLower.get(name.toLowerCase());
    return real === undefined ? null : join(dir, real);
  };

  /** Only a candidate whose realpath is itself and inside the root (no symlink anywhere). */
  const isOwnRealPath = async (p: string, root: string): Promise<boolean> =>
    p !== root && isWithin(p, root) && (await fs.realpath(p)) === p;

  /** The `.nfo` `name` in `dir` when it parses (any of the three roots); null on any problem. */
  const nfoAt = async (dir: string, name: string, root: string): Promise<Nfo | null> => {
    const p = await find(dir, name, root);
    if (p === null) return null;
    try {
      if (!(await isOwnRealPath(p, root))) return null;
      return readNfo(await fs.readText(p, NFO_MAX_BYTES));
    } catch (err) {
      debug('could not read a .nfo file', p, err);
      return null;
    }
  };

  /** `tvshow.nfo` in `dir`, parsed once per folder. */
  const showAt = (dir: string, root: string): Promise<Nfo | null> => {
    let cached = shows.get(dir);
    if (cached === undefined) {
      cached = nfoAt(dir, 'tvshow.nfo', root).then((nfo) => withRoot(nfo, 'tvshow'));
      shows.set(dir, cached);
    }
    return cached;
  };

  /**
   * The first `<name><ext>` in `dir` that is a regular file at its own real path: every exact-case
   * name first, then case-insensitive matches.
   */
  const posterIn = async (dir: string, names: string[], root: string): Promise<string | null> => {
    const tried = new Set<string>();
    for (const exactOnly of [true, false]) {
      for (const name of names) {
        for (const ext of POSTER_EXTENSIONS) {
          const p = await find(dir, `${name}${ext}`, root, exactOnly);
          if (p === null || tried.has(p)) continue;
          tried.add(p);
          try {
            if ((await isOwnRealPath(p, root)) && (await fs.lstat(p)).isFile()) return p;
          } catch (err) {
            debug('could not check a poster image', p, err);
          }
        }
      }
    }
    return null;
  };

  /** A show folder's poster (`poster`, else `folder`), looked up once per folder. */
  const showPosterIn = (dir: string, root: string): Promise<string | null> => {
    let cached = showPosters.get(dir);
    if (cached === undefined) {
      cached = posterIn(dir, ['poster', 'folder'], root);
      showPosters.set(dir, cached);
    }
    return cached;
  };

  /** A step that fails leaves the earlier value. */
  const step = async <T>(what: string, path: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      debug(what, path, err);
      return null;
    }
  };

  return {
    async resolve(path, libraryRoot) {
      const media = parseFileName(path, libraryRoot);
      const root = libraryRoot;
      const dir = dirname(path);
      const stem = basename(path, extname(path));

      // <stem>.nfo beside the file, read once: an episode's or a movie's. A usable one decides
      // the kind before the file name does.
      const stemNfo = await step('could not read the .nfo beside the file', path, () =>
        nfoAt(dir, `${stem}.nfo`, root),
      );
      // Only a movie .nfo with a title or year counts; an empty one falls through to movie.nfo.
      const stemMovieNfo = withRoot(stemNfo, 'movie');
      const stemMovie =
        stemMovieNfo !== null && (stemMovieNfo.title !== null || stemMovieNfo.year !== null)
          ? stemMovieNfo
          : null;
      if (stemMovie !== null) {
        media.kind = 'movie';
        media.season = null;
        media.episode = null;
        media.episodeTitle = null;
      }
      const episodeNfo = withRoot(stemNfo, 'episodedetails');
      const episodeUsable =
        episodeNfo !== null &&
        (episodeNfo.title ?? episodeNfo.showTitle ?? episodeNfo.season ?? episodeNfo.episode) !==
          null;
      if (episodeNfo !== null && episodeUsable) {
        media.kind = 'episode';
        media.source = 'sidecar';
        media.episodeTitle = episodeNfo.title;
        media.season = episodeNfo.season ?? media.season;
        media.episode = episodeNfo.episode ?? media.episode;
      }

      if (media.kind === 'episode') {
        // tvshow.nfo in the file's folder or its parent (the show folder), never above the root.
        const found = await step('could not read tvshow.nfo', path, async () => {
          for (const folder of [dir, dirname(dir)]) {
            if (!isWithin(folder, root)) continue;
            const nfo = await showAt(folder, root);
            if (nfo !== null) return { nfo, folder };
          }
          return null;
        });
        const show = found?.nfo ?? null;
        if (show !== null && (show.title !== null || show.year !== null)) {
          media.source = 'sidecar';
          if (show.title !== null) media.title = show.title;
          if (show.year !== null) media.year = show.year;
        }
        if (show?.title == null && episodeUsable && episodeNfo?.showTitle != null) {
          media.title = episodeNfo.showTitle;
        }
        // The show poster: in the folder that held tvshow.nfo, else a season folder's parent, else
        // the file's folder; never the library root itself unless tvshow.nfo is there.
        let showFolder: string | null = found?.folder ?? null;
        if (showFolder === null) {
          const parent = dirname(dir);
          if (isSeasonFolder(basename(dir)) && isWithin(parent, root) && parent !== root) {
            showFolder = parent;
          } else if (dir !== root && isWithin(dir, root)) {
            showFolder = dir;
          }
        }
        if (showFolder !== null) {
          const folder = showFolder;
          media.posterPath = await step('could not find a show poster', path, () =>
            showPosterIn(folder, root),
          );
        }
        return media;
      }

      // Movie .nfo: <stem>.nfo, else movie.nfo (not in the library root: it would name every file).
      const movie =
        stemMovie ??
        (dir === root
          ? null
          : await step('could not read movie.nfo', path, async () =>
              withRoot(await nfoAt(dir, 'movie.nfo', root), 'movie'),
            ));
      if (movie !== null && (movie.title !== null || movie.year !== null)) {
        media.kind = 'movie';
        media.source = 'sidecar';
        if (movie.title !== null) media.title = movie.title;
        if (movie.year !== null) media.year = movie.year;
      }

      // Poster: <stem>-poster anywhere; poster, folder, cover only outside the root itself.
      const names =
        dir === root ? [`${stem}-poster`] : [`${stem}-poster`, 'poster', 'folder', 'cover'];
      media.posterPath = await step('could not find a poster', path, () =>
        posterIn(dir, names, root),
      );
      return media;
    },
  };
}
