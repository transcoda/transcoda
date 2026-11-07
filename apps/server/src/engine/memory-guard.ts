// The memory guard: a long read-only ffmpeg pass (Check source, verify's decodes) whose resident
// memory grows past a limit is stopped. A decode needs little memory (a 4K 10-bit HEVC film with
// two audio tracks stays under 600 MiB); one that grows is buffering, typically the null muxer
// queueing every decoded frame while it waits for a stream that never sends one (a cover stored
// as a video track). Without the guard that fills the container and can thrash the whole host.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';

const GiB = 2 ** 30;
const MiB = 2 ** 20;

/** The guard reads the child's RSS this often (a runaway pass grows by roughly 50 MB/s). */
export const MEMORY_CHECK_MS = 1_000;
/** The default limit, at most: about seven times what a legitimate 4K decode needs. */
export const DECODE_MEMORY_MAX_DEFAULT = 4 * GiB;
/** The default limit, at least (half of a very small container would stop real decodes). */
export const DECODE_MEMORY_MIN_DEFAULT = 1 * GiB;

/** `VmRSS` of a `/proc/<pid>/status` in bytes; null when absent (a kernel thread, not Linux). */
export function parseRss(status: string): number | null {
  const m = /^VmRSS:\s*(\d+)\s*kB/m.exec(status);
  return m ? Number(m[1]) * 1024 : null;
}

/** The resident memory of `pid` in bytes; null when it cannot be read (not Linux, gone). */
export async function readRss(pid: number): Promise<number | null> {
  try {
    return parseRss(await readFile(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return null;
  }
}

/** A cgroup memory limit file's value in bytes; null for none (`max`, v1's huge no-limit value). */
export function parseCgroupLimit(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n < 2 ** 62 ? n : null;
}

/** The memory this server may use: its cgroup's limit (v2, then v1), else the machine's. */
export function availableMemory(): number | null {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const limit = parseCgroupLimit(readFileSync(file, 'utf8'));
      if (limit !== null) return Math.min(limit, totalmem());
    } catch {
      // no such cgroup file
    }
  }
  const total = totalmem();
  return total > 0 ? total : null;
}

/**
 * The default limit: half of the memory available (the server, an encode and other passes need
 * the rest), at least 1 GiB and at most 4 GiB. 4 GiB is about seven times what a 4K decode needs
 * and half of the 8 GB a typical container gets; a runaway pass reaches it within a minute or two.
 */
export function defaultDecodeMemoryBytes(available: number | null): number {
  if (available === null) return DECODE_MEMORY_MAX_DEFAULT;
  return Math.min(
    DECODE_MEMORY_MAX_DEFAULT,
    Math.max(DECODE_MEMORY_MIN_DEFAULT, Math.floor(available / 2)),
  );
}

let configured: number | null | undefined;

/**
 * Set at start-up from TRANSCODA_DECODE_MEMORY_GIB: bytes, null (the guard is off) or undefined
 * (the default, worked out on first use).
 */
export function setDecodeMemoryLimit(bytes: number | null | undefined): void {
  configured = bytes;
}

/** The limit for read-only ffmpeg passes in bytes; null when the guard is off. */
export function decodeMemoryLimit(): number | null {
  if (configured === undefined) configured = defaultDecodeMemoryBytes(availableMemory());
  return configured;
}

/** `4 GiB`, `1.5 GiB`, `512 MiB`. */
function size(bytes: number): string {
  if (bytes >= GiB) return `${Math.round((bytes / GiB) * 10) / 10} GiB`;
  return `${Math.round(bytes / MiB)} MiB`;
}

export function memoryLimitMessage(limitBytes: number): string {
  return `ffmpeg used more than ${size(limitBytes)} of memory and was stopped`;
}

/**
 * The guard stopped the tool. `killed` like a timeout (the run says nothing about the file's
 * content); `stderr` is what the tool had written.
 */
export class MemoryLimitError extends Error {
  override readonly name = 'MemoryLimitError';
  readonly killed = true;
  readonly memoryLimitBytes: number;
  readonly stderr: string;
  constructor(limitBytes: number, stderr: string) {
    super(memoryLimitMessage(limitBytes));
    this.memoryLimitBytes = limitBytes;
    this.stderr = stderr;
  }
}

/** A MemoryLimitError, or an error its fields were copied onto. */
export function isMemoryLimitError(err: unknown): err is MemoryLimitError {
  const e = err as { name?: unknown; memoryLimitBytes?: unknown } | null;
  return (
    e !== null &&
    typeof e === 'object' &&
    e.name === 'MemoryLimitError' &&
    typeof e.memoryLimitBytes === 'number'
  );
}

/**
 * Reads `pid`'s RSS every `intervalMs` and calls `onExceed` once when it is above `limitBytes`
 * (then stops watching). An RSS that cannot be read is never over. Returns the stop function.
 */
export function watchMemory(o: {
  pid: number;
  limitBytes: number;
  onExceed: (rssBytes: number) => void;
  read?: (pid: number) => Promise<number | null>;
  intervalMs?: number;
}): () => void {
  const read = o.read ?? readRss;
  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void read(o.pid)
      .then((rss) => {
        if (stopped || rss === null || rss <= o.limitBytes) return;
        stop();
        o.onExceed(rss);
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, o.intervalMs ?? MEMORY_CHECK_MS);
  timer.unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
