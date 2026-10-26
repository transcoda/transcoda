import type { Library } from '@transcoda/contract';

/** `root` without trailing slashes (`/` stays `/`). */
function trimRoot(root: string): string {
  const trimmed = root.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The library a path belongs to: the one whose root is the longest path-segment prefix of `path`
 * (`/media/tv` does not hold `/media/tv2/x.mkv`). null when no root holds it.
 */
export function libraryForPath(libraries: readonly Library[], path: string): Library | null {
  let best: Library | null = null;
  let bestLength = -1;
  for (const library of libraries) {
    const root = trimRoot(library.path);
    const holds = path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
    if (holds && root.length > bestLength) {
      best = library;
      bestLength = root.length;
    }
  }
  return best;
}
