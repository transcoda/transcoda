import { constants } from 'node:fs';
import { access, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { BROWSE_DIRS_MAX, type FsBrowseDirsOutput, type FsDirEntry } from '@transcoda/contract';
import type { Config } from '../config.ts';

/**
 * System folders the folder picker never shows or enters, whatever their permissions (the
 * config, transcode, plugin run and install folders are added by {@link hiddenRoots}).
 */
export const ALWAYS_HIDDEN = ['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/root'];

/** The default `TRANSCODA_PLUGIN_RUN_DIR` (hidden even when isolation is not configured). */
const DEFAULT_PLUGIN_RUN_DIR = '/run/transcoda/plugins';

/**
 * Every folder the picker hides (and everything under each): the system ones, the config folder
 * (database and secret key), the transcode scratch folder, the plugin run folder and the app's
 * own install folder.
 */
export function hiddenRoots(config: Config, installDir: string | null): string[] {
  return [
    ...ALWAYS_HIDDEN,
    config.configDir,
    config.transcodeDir,
    config.pluginIsolation?.runDir ?? DEFAULT_PLUGIN_RUN_DIR,
    ...(installDir === null ? [] : [installDir]),
  ];
}

/** Both spellings of a root: as given (resolved) and its real path (a link or `/etc` on macOS). */
async function expandRoots(roots: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const root of roots) {
    const lexical = resolve(root);
    out.add(lexical);
    try {
      out.add(await realpath(lexical));
    } catch {
      // A root that does not exist here hides nothing more than its own spelling.
    }
  }
  return [...out];
}

function isUnder(path: string, root: string): boolean {
  if (root === sep) return true;
  return path === root || path.startsWith(root + sep);
}

async function can(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * The install folder to hide, or null when it came out as `/` (a bundle laid out flat in the root):
 * hiding `/` would hide everything, so it is ignored, with a log line.
 */
export function usableInstallDir(
  dir: string,
  log: { warn(entry: { msg: string }): void },
): string | null {
  if (resolve(dir) !== sep) return resolve(dir);
  log.warn({ msg: 'install folder resolved to /: not hiding it from the folder picker' });
  return null;
}

/** `dev:ino` of a path, or null when it cannot be read. Injected in tests to fake a bind mount. */
export type Identify = (path: string) => Promise<string | null>;

const identifyPath: Identify = async (path) => {
  try {
    const st = await stat(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};

/** `/a/b/c` as `['/', '/a', '/a/b', '/a/b/c']`. */
function chainOf(path: string): string[] {
  const out: string[] = [sep];
  let at = '';
  for (const part of path.split(sep).filter((p) => p !== '')) {
    at += sep + part;
    out.push(at);
  }
  return out;
}

const hasDotPart = (path: string) => path.split(sep).some((p) => p.startsWith('.'));

/** How many directory entries are looked at before the listing is cut off (and marked truncated). */
export const SCAN_CAP = 20_000;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The readable sub-folders of an absolute folder. Returns `'refused'` for every path it will not
 * list (relative, missing, not a folder, unreadable, with a dot-named part, or at or under a
 * hidden root: by its spelling, by its real path (symlinks) or by device and inode (bind mounts
 * of a hidden root, here or in an ancestor)) so nothing in the answer says which of these it was.
 * Folders list by name (dot-names omitted); a symlink to a folder lists under its own name with
 * the target's real path; unreadable folders are omitted; `writable` is false for a folder the
 * app user cannot create files in.
 *
 * Cost: names are filtered without syscalls, sorted, and only then realpath/stat/access'd, until
 * `max` are accepted (`truncated` when names remain). At most `scanCap` entries are read from a
 * directory (`truncated` when it has more).
 *
 * Accepted limit: between the realpath check and the directory read, an attacker who can already
 * replace path components on this disk could swap a symlink (TOCTOU). The server only reads names,
 * never file contents, and the people who can browse are signed-in admins; the library path is
 * validated again when a library is created.
 */
export async function browseDirs(
  requested: string,
  options: { hidden: string[]; max?: number; scanCap?: number; identify?: Identify },
): Promise<FsBrowseDirsOutput | 'refused'> {
  const max = options.max ?? BROWSE_DIRS_MAX;
  const scanCap = options.scanCap ?? SCAN_CAP;
  const identify = options.identify ?? identifyPath;
  if (!requested.startsWith('/') || requested.includes('\0')) return 'refused';
  const hidden = await expandRoots(options.hidden);
  const isHidden = (p: string) => hidden.some((root) => isUnder(p, root));
  const hiddenIds = new Set<string>();
  for (const root of hidden) {
    const id = await identify(root);
    if (id !== null) hiddenIds.add(id);
  }

  const lexical = resolve(requested);
  // The request as spelled, before any symlink is followed: a link inside a hidden root that
  // points out is still a way into the hidden folder.
  if (isHidden(lexical) || hasDotPart(lexical)) return 'refused';

  let real: string;
  try {
    real = await realpath(lexical);
    if (isHidden(real) || hasDotPart(real)) return 'refused';
    for (const part of chainOf(real)) {
      const id = await identify(part);
      if (id !== null && hiddenIds.has(id)) return 'refused';
    }
    if (!(await stat(real)).isDirectory()) return 'refused';
    if (!(await can(real, constants.R_OK | constants.X_OK))) return 'refused';
  } catch {
    return 'refused';
  }

  // Names only, no syscalls per entry; stop reading at the scan cap.
  const names: string[] = [];
  let truncated = false;
  try {
    const dir = await opendir(real);
    let scanned = 0;
    try {
      for await (const d of dir) {
        if (++scanned > scanCap) {
          truncated = true;
          break;
        }
        if (d.name.startsWith('.')) continue;
        if (d.isDirectory() || d.isSymbolicLink()) names.push(d.name);
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  } catch {
    return 'refused';
  }
  names.sort((a, b) => collator.compare(a, b) || (a < b ? -1 : 1));

  const entries: FsDirEntry[] = [];
  let next = 0;
  for (; next < names.length && entries.length < max; next++) {
    const name = names[next] as string;
    let target: string;
    try {
      target = await realpath(resolve(real, name));
      if (isHidden(target) || hasDotPart(target)) continue;
      if (!(await stat(target)).isDirectory()) continue;
      const id = await identify(target);
      if (id !== null && hiddenIds.has(id)) continue;
    } catch {
      continue;
    }
    if (!(await can(target, constants.R_OK | constants.X_OK))) continue;
    entries.push({
      name,
      path: target,
      writable: await can(target, constants.W_OK | constants.X_OK),
    });
  }
  // Names left unchecked may all turn out hidden: the flag is conservative.
  if (next < names.length) truncated = true;
  return {
    path: real,
    writable: await can(real, constants.W_OK | constants.X_OK),
    parent: real === sep ? null : dirname(real),
    entries,
    truncated,
  };
}
