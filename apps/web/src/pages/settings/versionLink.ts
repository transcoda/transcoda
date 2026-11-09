const REPO = 'https://github.com/transcoda/transcoda';

/**
 * Where the running version is described on GitHub: a release (pre-releases too) links to its
 * release page; a `-dev+<commit>` build links to that commit. Null for a `-dev` build without a
 * commit, or for anything that is not a version (still loading, couldn't be read).
 */
export function versionLink(version: string): string | null {
  const dev = /^\d+\.\d+\.\d+-dev(?:\+([0-9a-f]{7,40}))?$/.exec(version);
  if (dev) return dev[1] ? `${REPO}/commit/${dev[1]}` : null;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? `${REPO}/releases/tag/v${version}`
    : null;
}
