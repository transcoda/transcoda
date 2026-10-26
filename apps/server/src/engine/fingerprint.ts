import { stat } from 'node:fs/promises';

/** Identity of a file on disk: if any of size, mtime, inode or device changes, it is a new file. */
export interface Fingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  /** Hard-link count; reported, but not part of the identity. */
  nlink: number;
}

/** @internal Test helper (the engine fingerprints from the stats it already has: `fingerprintFromStats`). */
export async function fingerprintOf(
  path: string,
  fs: Pick<typeof import('node:fs/promises'), 'stat'> = { stat },
): Promise<Fingerprint> {
  const st = await fs.stat(path);
  return { sizeBytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev, nlink: st.nlink };
}

export function fingerprintKey(f: Fingerprint): string {
  return `${f.dev}:${f.ino}:${f.sizeBytes}:${f.mtimeMs}`;
}

/** Same file, unchanged: size, mtime, inode and device match (nlink is ignored). */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev
  );
}
