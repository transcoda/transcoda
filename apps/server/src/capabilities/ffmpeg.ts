import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capabilities } from '@transcoda/contract';
import { wrapChild } from '../engine/child-caps.ts';

/** Runs a tool; `signal` aborts the run and SIGKILLs the child (no orphaned ffmpeg). */
export type Exec = (
  file: string,
  args: string[],
  opts?: {
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    /** Overrides the exec's own time limit for this call (ms). */
    timeoutMs?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/**
 * An Exec over `execFile` (no shell) with a timeout and output limit. An abort SIGKILLs the child
 * and rejects with an AbortError (execFile's own `signal` option would send SIGTERM, which a
 * stuck process can ignore). `onStdout` sees stdout as it arrives (it is returned in full too).
 */
export function makeExec(limits: { timeout: number; maxBuffer: number }): Exec {
  return async (file, args, opts) => {
    const signal = opts?.signal;
    if (signal?.aborted) throw abortError();
    const cmd = wrapChild(file, args);
    const run = execFileAsync(cmd.file, cmd.args, {
      timeout: opts?.timeoutMs ?? limits.timeout,
      maxBuffer: limits.maxBuffer,
      killSignal: 'SIGKILL',
    });
    const onAbort = (): void => {
      run.child.kill('SIGKILL');
    };
    const onStdout = opts?.onStdout;
    if (onStdout) run.child.stdout?.on('data', (chunk) => onStdout(String(chunk)));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { stdout, stderr } = await run;
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export const defaultExec: Exec = makeExec({ timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });

/** `ffmpeg version 9.0.2 Copyright ...` -> `9.0.2`. Throws when the output is not ffmpeg's. */
export function parseVersion(stdout: string): string {
  const m = /^ffmpeg version (\S+)/m.exec(stdout);
  if (!m?.[1]) throw new Error('unrecognised ffmpeg -version output');
  return m[1];
}

/** Encoder names from `ffmpeg -encoders` . */
export function parseEncoders(stdout: string): string[] {
  const names: string[] = [];
  const lines = stdout.split('\n');
  // The legend (` V..... = Video`) matches the flag pattern too; the list starts after `------`.
  const sep = lines.findIndex((l) => l.trim() === '------');
  for (const line of lines.slice(sep + 1)) {
    const m = /^\s[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** Method names listed after `Hardware acceleration methods:` in `ffmpeg -hwaccels`. */
export function parseHwaccels(stdout: string): string[] {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Hardware acceleration methods:');
  if (start < 0) return [];
  return lines
    .slice(start + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Filter names from `ffmpeg -filters`. Flag columns are `T`imeline, `S`lice threading and, in older
 * builds, `C`ommand support (ffmpeg 9 prints two), so the third flag is optional.
 */
export function parseFilters(stdout: string): string[] {
  const lines = stdout.split('\n');
  const sep = lines.findIndex((l) => l.trim() === '------');
  if (sep < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(sep + 1)) {
    const m = /^\s[T.][S.][C.]?\s+([A-Za-z0-9_]+)\s+\S+->\S+/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** Probe an ffmpeg binary. Never throws: any failure becomes `available: false`. */
export async function probeFfmpeg(path: string, exec: Exec = defaultExec): Promise<Capabilities> {
  try {
    const base = ['-hide_banner'];
    const version = parseVersion((await exec(path, [...base, '-version'])).stdout);
    const encoders = parseEncoders((await exec(path, [...base, '-encoders'])).stdout);
    const hwaccels = parseHwaccels((await exec(path, [...base, '-hwaccels'])).stdout);
    const filters = parseFilters((await exec(path, [...base, '-filters'])).stdout);
    return { available: true, path, version, encoders, hwaccels, filters };
  } catch (e) {
    return { available: false, path, error: e instanceof Error ? e.message : String(e) };
  }
}
