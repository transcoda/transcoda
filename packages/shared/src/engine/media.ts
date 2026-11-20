/** The file extensions the engine treats as media (lower case, with the dot). */
export const MEDIA_EXTENSIONS = [
  '.mkv',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.ts',
  '.m2ts',
  '.webm',
  '.wmv',
  '.flv',
] as const;

/**
 * Whether a path's last segment has a media extension, by its text only (no disk access, so it
 * works in the browser). A trailing slash names a folder: false. A dotfile such as `.mkv` has no
 * extension, as with node's `extname`.
 */
export function isMediaPath(path: string): boolean {
  if (path.endsWith('/') || path.endsWith('\\')) return false;
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return (MEDIA_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase());
}

export type MediaKind = 'movie' | 'episode' | 'unknown';

/** What the Jobs list shows for a file: a human title instead of its path. */
export interface StoredJobMedia {
  kind: MediaKind;
  /** Never empty. */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  source: 'sidecar' | 'filename';
  /** Server-internal. */
  posterPath: string | null;
  /**
   * Server-internal. An episode's show poster (`poster` or `folder` in the show folder) when it
   * has one, even when `posterPath` is a more specific one; absent otherwise and on older jobs.
   */
  showPosterPath?: string;
}

/** Tags that never start a title: a resolution, a source or a codec. Always a cut point. */
const HARD_TAGS = new Set([
  '480p',
  '576p',
  '720p',
  '1080p',
  '2160p',
  '4k',
  'bluray',
  'brrip',
  'bdrip',
  'web-dl',
  'webdl',
  'webrip',
  'hdtv',
  'dvdrip',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'av1',
]);

/**
 * Tags that are also words (`A Proper Job`, `The DV Files`): a cut point only after a year, so a
 * title that starts with one stays whole.
 */
const WORD_TAGS = new Set(['proper', 'repack', 'dv', 'hdr', 'uhd', 'avc', 'remux']);

/** First match wins: `S01E17`, `s1e2`, then `1x02`. */
const EPISODE_PATTERN =
  /(?<![A-Za-z0-9])(?:s(\d{1,2})e(\d{1,3})(?!\d)|(\d{1,2})x(\d{2,3})(?![A-Za-z0-9]))/i;
const SEASON_FOLDER = /^(?:season\s*\d{1,2}|s\d{1,2}|specials)$/i;
const YEAR_TOKEN = /^[([]?((?:19|20)\d\d)[)\]]?$/;
const TRAILING_YEAR = /[([]((?:19|20)\d\d)[)\]]$/;

/** True for `Season 01`, `Season 1`, `S01`, `Specials` (case-insensitive). */
export function isSeasonFolder(name: string): boolean {
  return SEASON_FOLDER.test(name.trim());
}

/**
 * `text` without leading characters in `lead` and trailing ones in `trail`. A plain scan instead of `[…]+$`,
 * which backtracks quadratically on a long run that does not reach the end.
 */
function trimChars(text: string, lead: string, trail: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && lead.includes(text[start] as string)) start++;
  while (end > start && trail.includes(text[end - 1] as string)) end--;
  return text.slice(start, end);
}

const SPACE_OR_DASH = ' \t\n\r\f\v-';

function stripBrackets(token: string): string {
  return trimChars(token, '([{', ')]}');
}

/** Dots and underscores to spaces, whitespace collapsed, as tokens. */
function tokenize(text: string): string[] {
  return text
    .replace(/[._]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');
}

const tagOf = (token: string): string => stripBrackets(token).toLowerCase();

/**
 * Tokens up to (not including) the first release tag: the first hard tag, or a word tag after a
 * year (the year of a title never starts it, so it is looked for from the second token on).
 */
function beforeReleaseTag(tokens: string[]): string[] {
  const hard = tokens.findIndex((t) => HARD_TAGS.has(tagOf(t)));
  const head = hard === -1 ? tokens : tokens.slice(0, hard);
  let year = -1;
  for (let i = head.length - 1; i >= 1; i--) {
    if (YEAR_TOKEN.test(head[i] as string)) {
      year = i;
      break;
    }
  }
  if (year === -1) return head;
  const word = head.findIndex((t, i) => i > year && WORD_TAGS.has(tagOf(t)));
  return word === -1 ? head : head.slice(0, word);
}

function trimDashes(text: string): string {
  return trimChars(text, SPACE_OR_DASH, SPACE_OR_DASH);
}

/** Cleaned text from the tokens: no release tags, no trailing dash. May be empty. */
function cleanTokens(tokens: string[]): string {
  return trimDashes(beforeReleaseTag(tokens).join(' '));
}

/** Clean a show or folder name and move a `(year)` suffix out of it. */
function cleanShowTitle(text: string): { title: string; year: number | null } {
  const cleaned = cleanTokens(tokenize(text));
  const m = TRAILING_YEAR.exec(cleaned);
  if (m) {
    const title = trimDashes(cleaned.slice(0, m.index));
    if (title !== '') return { title, year: Number(m[1]) };
  }
  return { title: cleaned, year: null };
}

function stripMediaExtension(name: string): string {
  return isMediaPath(name) ? name.slice(0, name.lastIndexOf('.')) : name;
}

/** The nearest parent folder that is neither a season folder nor the library root. */
function nearestShowFolder(segments: string[], libraryRoot: string | undefined): string | null {
  const root = libraryRoot === undefined ? undefined : trimChars(libraryRoot, '', '/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const name = segments[i] as string;
    if (name === '') return null;
    if (root !== undefined && segments.slice(0, i + 1).join('/') === root) return null;
    if (!isSeasonFolder(name)) return name;
  }
  return null;
}

/** Always source 'filename', posterPath null, episodeTitle null. POSIX paths; never throws. */
export function parseFileName(path: string, libraryRoot?: string): StoredJobMedia {
  const segments = path.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  const base = stripMediaExtension(fileName);
  const result = (
    kind: MediaKind,
    title: string,
    year: number | null,
    season: number | null,
    episode: number | null,
  ): StoredJobMedia => ({
    kind,
    title: title !== '' ? title : base !== '' ? base : path !== '' ? path : 'Untitled',
    year,
    season,
    episode,
    episodeTitle: null,
    source: 'filename',
    posterPath: null,
  });

  const ep = EPISODE_PATTERN.exec(base);
  if (ep) {
    const season = Number(ep[1] ?? ep[3]);
    const episode = Number(ep[2] ?? ep[4]);
    let show = cleanShowTitle(base.slice(0, ep.index));
    if (show.title === '') {
      const folder = nearestShowFolder(segments, libraryRoot);
      if (folder !== null) show = cleanShowTitle(folder);
    }
    if (show.title === '') show = { title: cleanTokens(tokenize(base)), year: null };
    return result('episode', show.title, show.year, season, episode);
  }

  // A dotfile such as `.mkv` has no real name: keep it as is rather than clean the dot away.
  if (base.startsWith('.')) return result('unknown', base, null, null, null);

  const tokens = beforeReleaseTag(tokenize(base));
  for (let i = tokens.length - 1; i >= 1; i--) {
    const m = YEAR_TOKEN.exec(tokens[i] as string);
    if (!m) continue;
    const title = trimDashes(tokens.slice(0, i).join(' '));
    if (title !== '') return result('movie', title, Number(m[1]), null, null);
  }
  return result('unknown', trimDashes(tokens.join(' ')), null, null, null);
}
