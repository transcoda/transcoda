// Files on disk as the database keys them. The row functions for the `files` table still live in
// jobs.ts.

/** Identity of a file on disk: if any of size, mtime, inode or device changes, it is a new file. */
export interface Fingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  /** Hard-link count; reported, but not part of the identity. */
  nlink: number;
}

/** The key the jobs and files tables store for a fingerprint (`fingerprint`, `output_fingerprint`). */
export function fingerprintKey(f: Fingerprint): string {
  return `${f.dev}:${f.ino}:${f.sizeBytes}:${f.mtimeMs}`;
}
