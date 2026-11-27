import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import type { JsonValue } from '@transcoda/shared';
import { describeExit, type ExitReason } from '../runtime/process.ts';
import type { BlockMatch } from '../trust/blocklist.ts';
import type { JsonObject } from './types.ts';

// Small helpers the plugin service's files share.

export const blockedReason = (m: BlockMatch): string => `blocklisted: ${m.reason}`;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The sandbox's read grant is for the exact path the host imports: a parent directory that is a
 * symlink (macOS's /var, a /config mount) would otherwise make the grant miss the file.
 */
export function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** What `install` and `update` answer when the process did not come up. */
export function startFailure(reason: ExitReason): string {
  return reason.kind === 'bad-manifest'
    ? reason.message
    : `plugin crashed on start: ${describeExit(reason)}`;
}

/** Whether `local` is a directory inside a library root (also run on a test's root folders). */
export function libraryCheck(
  local: string,
  libraryRoots: () => string[],
): { ok: boolean; message: string } {
  let real: string;
  try {
    real = realpathSync(local);
  } catch {
    return { ok: false, message: `${local} does not exist` };
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, message: `${local} is not a directory` };
    }
  } catch {
    return { ok: false, message: `${local} cannot be read` };
  }
  for (const root of libraryRoots()) {
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      continue;
    }
    if (real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) {
      return { ok: true, message: `${local} is inside the library ${root}` };
    }
  }
  return { ok: false, message: `${local} is not inside any library` };
}
