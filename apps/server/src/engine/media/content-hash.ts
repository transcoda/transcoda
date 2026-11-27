import { createHash } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';

/**
 * A sampled content hash: the same bytes give the same hash at any path, on any filesystem, so an
 * identical copy or re-download of a file is recognised where its fingerprint (inode, mtime) is
 * not. Format `v1:<size>:<sha256 hex>`; the sha256 covers the scheme, the size and three chunks of
 * HASH_CHUNK_BYTES read at the start, the middle and the end. A file no larger than the three
 * chunks together is hashed whole. The version prefix lets the scheme change later (an old hash
 * then simply never matches).
 *
 * 4 MiB per chunk, 12 MiB per file: the start and end cover the container's headers and index
 * (Matroska segment info and cues, MP4 `moov` at either end) and the middle a run of media
 * packets, so two encodes of the same source differ in what is read. On a local disk it costs a
 * few milliseconds; on a gigabit network share about 0.1 s, against reading a whole film.
 */
export const HASH_SCHEME = 'v1';
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export class HashAborted extends Error {
  constructor() {
    super('content hash aborted');
    this.name = 'AbortError';
  }
}

export interface ContentHashOptions {
  signal?: AbortSignal;
  /** Bytes per chunk (tests use small ones). */
  chunkBytes?: number;
  /** @internal Test seam. */
  openFile?: (path: string) => Promise<FileHandle>;
}

const errorCode = (err: unknown): unknown =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

/** Reads exactly `length` bytes at `offset`; null when the file ended early (it shrank). */
async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer | null> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) return null;
    done += bytesRead;
  }
  return buf;
}

/** The offsets read: the whole file in chunks when it is small, else start, middle and end. */
export function chunkOffsets(size: number, chunk: number): { offset: number; length: number }[] {
  if (size <= 3 * chunk) {
    const out: { offset: number; length: number }[] = [];
    for (let offset = 0; offset < size; offset += chunk) {
      out.push({ offset, length: Math.min(chunk, size - offset) });
    }
    return out;
  }
  return [
    { offset: 0, length: chunk },
    { offset: Math.floor((size - chunk) / 2), length: chunk },
    { offset: size - chunk, length: chunk },
  ];
}

/**
 * The file's sampled content hash; null when it is missing, not a regular file, or changed size
 * while it was read. Reads only the sampled chunks. Throws HashAborted when `signal` aborts (checked
 * before each read) and rethrows other I/O errors.
 */
export async function contentHash(
  path: string,
  opts: ContentHashOptions = {},
): Promise<string | null> {
  const chunk = opts.chunkBytes ?? HASH_CHUNK_BYTES;
  const aborted = () => {
    if (opts.signal?.aborted) throw new HashAborted();
  };
  aborted();
  let fh: FileHandle;
  try {
    fh = await (opts.openFile ?? ((p) => open(p, 'r')))(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const size = st.size;
    const hash = createHash('sha256').update(`${HASH_SCHEME}\0${size}\0`);
    for (const { offset, length } of chunkOffsets(size, chunk)) {
      aborted();
      const buf = await readAt(fh, offset, length);
      if (buf === null) return null;
      hash.update(buf);
    }
    aborted();
    if ((await fh.stat()).size !== size) return null;
    return `${HASH_SCHEME}:${size}:${hash.digest('hex')}`;
  } finally {
    await fh.close();
  }
}
