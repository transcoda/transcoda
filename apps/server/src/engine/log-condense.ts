// The job log as `jobs.log` shows it (#43): the tail of the ffmpeg log with repeats said once, so a
// flood of one line never pushes the rest out of the tail.
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { errorCode } from './fs-ops.ts';

/**
 * libnuma via libx265 where it may not set a memory policy (Docker without CAP_SYS_NICE): printed
 * once per thread or frame, interleaved with everything else. Harmless.
 */
const FLOOD = /^set_mempolicy: Operation not permitted\s*$/;

/**
 * How a repeated line is marked: `<line> [transcoda: <n> times]`, or `at least <n>` when the scan
 * started after the log's start (the web reads it back).
 */
export const repeatedLine = (line: string, times: number, atLeast = false) =>
  `${line} [transcoda: ${atLeast ? 'at least ' : ''}${times} times]`;

/**
 * How much of the end of a log is read to condense it: a set_mempolicy flood can make a log
 * hundreds of MB, and `jobs.log` is read on every job page open and state change.
 */
export const LOG_SCAN_BYTES = 8 * 1024 * 1024;

/** Condensed tails by path, size and mtime: a finished job's log is condensed once. */
const cache = new Map<string, string>();
const CACHE_ENTRIES = 32;

/**
 * The last `bytes` (UTF-16 units, near enough) of the log at `path` after condensing: a line
 * repeated in a row is kept once, marked with how often it came; every set_mempolicy line is
 * counted into the first one, where it stands (or in front, when the tail starts after it).
 * Only the last `scanBytes` of the file are read, from the first whole line in them; a count
 * then says "at least" for the flood when the scan did not start at the log's start. Whole lines
 * only; a missing log is ''.
 */
export async function readCondensedTail(
  path: string,
  bytes: number,
  scanBytes = LOG_SCAN_BYTES,
): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return '';
    throw err;
  }
  try {
    const stat = await fh.stat();
    const key = `${path}#${stat.size}#${stat.mtimeMs}#${bytes}#${scanBytes}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Most recently used goes last; the oldest is dropped first.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const start = Math.max(0, stat.size - scanBytes);
    const text = await condense(fh, start, stat.size, bytes);
    cache.set(key, text);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    return text;
  } finally {
    await fh.close();
  }
}

async function condense(
  fh: Awaited<ReturnType<typeof open>>,
  start: number,
  size: number,
  bytes: number,
): Promise<string> {
  if (size === 0) return '';
  // Read at most up to the size seen, so a growing log never reads past what was measured.
  const stream = fh.createReadStream({ encoding: 'utf8', start, end: size - 1, autoClose: false });
  let endsWithNewline = false;
  stream.on('data', (chunk) => {
    if (chunk.length > 0) endsWithNewline = String(chunk).endsWith('\n');
  });
  /** The kept lines; the flood line is an object so its count can change after it is kept. */
  type Kept = { text: string; times: number };
  const kept: Kept[] = [];
  let used = 0;
  let flood: Kept | null = null;
  let last: Kept | null = null;
  const push = (k: Kept) => {
    kept.push(k);
    used += k.text.length + 1;
    while (used > bytes && kept.length > 1) {
      const gone = kept.shift() as Kept;
      used -= gone.text.length + 1;
    }
  };
  // Started inside the log: the first line read is most likely a part of one.
  let skip = start > 0;
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    if (skip) {
      skip = false;
      continue;
    }
    if (FLOOD.test(line)) {
      if (flood) flood.times++;
      else {
        flood = { text: line.trim(), times: 1 };
        push(flood);
      }
      continue;
    }
    if (last && last.text === line && last === kept.at(-1)) {
      last.times++;
      continue;
    }
    last = { text: line, times: 1 };
    push(last);
  }
  // Within budget the tail may have dropped the flood line: it goes in front.
  const lines = flood && !kept.includes(flood) ? [flood, ...kept] : kept;
  const text = lines
    .map((k) => {
      // Lines before the scan were not counted: the flood may have started there.
      const atLeast = k === flood && start > 0;
      return k.times > 1 || atLeast ? repeatedLine(k.text, k.times, atLeast) : k.text;
    })
    .join('\n');
  return lines.length > 0 && endsWithNewline ? `${text}\n` : text;
}
