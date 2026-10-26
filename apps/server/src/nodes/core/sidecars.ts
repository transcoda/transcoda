// Subtitle files next to a video (the ones Bazarr downloads): name parsing and discovery. Pure
// except for the injected file system.
import { constants, open } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { LANGUAGES, normalizeLanguage } from '@transcoda/shared';
import { errorCode, type FsOps } from '../../engine/fs-ops.ts';
import { MAX_SIDECAR_BYTES, MEDIA_EXTENSIONS } from '../../engine/paths.ts';

/** Sidecar extension → the subtitle codec ffmpeg reads it as. */
export const SIDECAR_EXTENSIONS = {
  srt: 'subrip',
  ass: 'ass',
  ssa: 'ass',
  vtt: 'webvtt',
  sup: 'hdmv_pgs_subtitle',
} as const;

export interface SidecarName {
  language: string | null;
  forced: boolean;
  sdh: boolean;
  default: boolean;
  title: string | null;
  codec: string;
}

/** Every ISO 639-1 and 639-2 (T and B) code, lower case. */
const LANGUAGE_TOKENS: ReadonlySet<string> = new Set(
  LANGUAGES.flatMap((l) => [l.t, l.b, l.one].filter((c): c is string => c !== null)),
);

/** The token's language code (`pt-BR` → `pt`), or null when it is not a language. */
function languageToken(token: string): string | null {
  const lower = token.toLowerCase();
  if (LANGUAGE_TOKENS.has(lower)) return lower;
  const region = /^([a-z]{2,3})-[a-z0-9]{2,4}$/.exec(lower);
  return region !== null && LANGUAGE_TOKENS.has(region[1] as string) ? (region[1] as string) : null;
}

/**
 * Reads `<videoBase>.<parts>.<ext>`; null when `fileName` is not a sidecar of that video (other
 * prefix, or an extension not in {@link SIDECAR_EXTENSIONS}). Parts, case-insensitive: `forced`,
 * `sdh`/`cc` (SDH), `default`, `hi` (SDH after a language, else Hindi), one language code
 * (639-1/639-2, optionally with a region); anything else becomes the title.
 */
export function parseSidecarName(
  videoBase: string,
  fileName: string,
): SidecarName | { skip: string } | null {
  if (!fileName.startsWith(`${videoBase}.`)) return null;
  const ext = extname(fileName).slice(1).toLowerCase();
  if (!Object.hasOwn(SIDECAR_EXTENSIONS, ext)) return null;
  const codec = SIDECAR_EXTENSIONS[ext as keyof typeof SIDECAR_EXTENSIONS];
  const middle = fileName.slice(videoBase.length + 1, fileName.length - ext.length - 1);
  const tokens = middle === '' ? [] : middle.split('.').filter((t) => t !== '');
  const name: SidecarName = {
    language: null,
    forced: false,
    sdh: false,
    default: false,
    title: null,
    codec,
  };
  const title: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'forced') name.forced = true;
    else if (lower === 'sdh' || lower === 'cc') name.sdh = true;
    else if (lower === 'default') name.default = true;
    else if (lower === 'hi' && name.language !== null) name.sdh = true;
    else {
      const code = languageToken(token);
      if (code === null) {
        title.push(token);
        continue;
      }
      const language = normalizeLanguage(code);
      if (name.language !== null && name.language !== language) {
        return { skip: 'two languages in the name' };
      }
      name.language = language;
    }
  }
  name.title = title.length > 0 ? title.join(' ') : null;
  return name;
}

export interface SidecarCandidate {
  /** The file's realpath. */
  path: string;
  file: string;
  name: SidecarName;
}
export interface SidecarSkip {
  file: string;
  reason: string;
}
export interface SidecarSource {
  find(videoPath: string): Promise<{ found: SidecarCandidate[]; skipped: SidecarSkip[] }>;
}

const NOT_UTF8 = 'not UTF-8 text (let Bazarr encode subtitles to UTF-8)';

function isText(buffer: Buffer): boolean {
  // A UTF-16 byte order mark: ffmpeg's text subtitle readers convert it.
  if (buffer.length >= 2) {
    const [a, b] = [buffer[0], buffer[1]];
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `max` bytes of a regular file. Opened without following a final symlink and without
 * blocking (a FIFO swapped in after the lstat would otherwise hang open()); anything but a regular
 * file is refused on the open handle, as `copyRegular` does.
 */
export async function readHead(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('it is not a regular file');
    const buffer = Buffer.alloc(max);
    let total = 0;
    while (total < max) {
      const { bytesRead } = await handle.read(buffer, total, max - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

const isMedia = (file: string) =>
  (MEDIA_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase());
const baseOf = (file: string) => file.slice(0, file.length - extname(file).length);

/**
 * Finds the sidecars of a video in its folder. Each subtitle file belongs to the sibling video
 * with the longest base name it parses against, so `Show.Part2.en.srt` is never `Show.mkv`'s.
 * Symlinks, directories, files whose realpath leaves the folder, empty files, files over 8 MiB
 * and text files that are not UTF-8 (or UTF-16 with a BOM) are skipped with a reason.
 */
export function fsSidecarSource(
  fs: Pick<FsOps, 'readdir' | 'lstat' | 'realpath'>,
  read: (p: string, max: number) => Promise<Buffer>,
): SidecarSource {
  return {
    async find(videoPath) {
      const dir = dirname(videoPath);
      const own = baseOf(basename(videoPath));
      const names = (await fs.readdir(dir)).map((e) => e.name).sort();
      const bases = [...new Set([own, ...names.filter(isMedia).map(baseOf)])].sort(
        (a, b) => b.length - a.length,
      );
      const realDir = await fs.realpath(dir);
      const found: SidecarCandidate[] = [];
      const skipped: SidecarSkip[] = [];
      for (const file of names) {
        if (isMedia(file)) continue;
        // Longest base first: the first that parses owns the file.
        let owner: string | null = null;
        let parsed: ReturnType<typeof parseSidecarName> = null;
        for (const base of bases) {
          parsed = parseSidecarName(base, file);
          if (parsed !== null) {
            owner = base;
            break;
          }
        }
        if (owner !== own || parsed === null) continue;
        if ('skip' in parsed) {
          skipped.push({ file, reason: parsed.skip });
          continue;
        }
        let reason: string | { path: string };
        try {
          reason = await check(join(dir, file), parsed.codec);
        } catch (err) {
          reason = `could not be read: ${errorCode(err) ?? (err instanceof Error ? err.message : String(err))}`;
        }
        if (typeof reason === 'string') skipped.push({ file, reason });
        else found.push({ path: reason.path, file, name: parsed });
      }
      return { found, skipped };

      async function check(path: string, codec: string): Promise<string | { path: string }> {
        const st = await fs.lstat(path);
        if (!st.isFile()) return 'not a regular file';
        const real = await fs.realpath(path);
        if (dirname(real) !== realDir) return "outside the video's folder";
        if (st.size === 0) return 'empty';
        if (st.size > MAX_SIDECAR_BYTES) return 'larger than 8 MiB';
        if (codec !== SIDECAR_EXTENSIONS.sup && !isText(await read(real, MAX_SIDECAR_BYTES))) {
          return NOT_UTF8;
        }
        return { path: real };
      }
    },
  };
}
