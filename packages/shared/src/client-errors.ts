// The web UI's error reports (docs/dev/web-ui.md, "Error reports"): what an event holds, how its
// text is scrubbed, and which errors are noise. The browser builds events with `clientErrorEvent`;
// the server parses them with `ClientErrorBatchSchema`, which scrubs them again, so a hand-made
// request cannot log anything the browser would not have sent.
import { z } from 'zod';

/** Where the web UI posts its reports (a plain route on the Transcoda server, same origin). */
export const CLIENT_ERRORS_PATH = '/api/client-errors';

/**
 * `error`: uncaught; `rejection`: an unhandled promise rejection; `render`: React lost the page;
 * `api`: an API call failed in a way the UI does not expect; `csp`: a Content Security Policy
 * violation. The metric's `kind` label is exactly this set.
 */
export const CLIENT_ERROR_KINDS = ['error', 'rejection', 'render', 'api', 'csp'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export const CLIENT_ERROR_LIMITS = {
  /** Events in one request. */
  batch: 20,
  /** Repeats one event can stand for. */
  count: 1000,
  /** Characters of a scrubbed message. */
  message: 200,
  /** Frames kept from a stack, top first. */
  frames: 15,
  /** Characters of one frame. */
  frame: 200,
  /** Characters of a function name in a frame. */
  functionName: 60,
} as const;

/** One report, already scrubbed. */
export interface ClientErrorEvent {
  kind: ClientErrorKind;
  /** The route pattern (`/jobs/:id`), never the real URL. */
  route: string;
  /** The web app's build version. */
  version: string;
  /** The error's class name (`TypeError`), or `Error`. */
  name: string;
  message: string;
  /** Frames, top first, as `at fn (/assets/index-abc.js:1:2)`: script paths only, no host. */
  stack: string[];
  /** How many times it happened since the last report. */
  count: number;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]*|\b(?:blob|data|file|mailto):[^\s'"`<>()]+/gi;
const EMAIL_RE = /[^\s@<>"'`()]+@[^\s@<>"'`()]+\.[^\s@<>"'`()]+/g;
// Where a path starts. A folder or file name can hold spaces, so nothing tells where a path ends:
// a path hides the rest of the message.
const PATH_START_RE =
  /\b[A-Za-z]:[\\/]|\\\\\S|(?<![\w<>/])(?:~|\.{1,2})?\/[^\s/'"`<>]|\b[\w.-]+[\\/][\w.()[\]-]/;
const MEDIA_FILE_RE =
  /\S*\.(?:mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv|srt|ass|ssa|sub|vtt|idx|sup|nfo|jpe?g|png|webp|mp3|flac|aac|m4a|ogg|opus|wav)\b/i;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
const HOST_PORT_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_ID_RE = /\b(?=[0-9a-z]*\d)[0-9a-z]{16,}\b/gi;
const TOKEN_RE = /\btcd_[\w-]+/g;

const PAIRED: Record<string, string> = {
  '"': '"',
  '`': '`',
  '“': '”',
  '«': '»',
  "'": "'",
  '‘': '’',
};
/** An opening quote with no closing one hides the rest of the message (not `'`: "can't"). */
const OPEN_TO_END = new Set(['"', '`', '“', '«']);

/** Every quoted run becomes `"…"`: a quoted value is data (a title, a JSON snippet), not code. */
function scrubQuotes(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const close = PAIRED[c];
    if (close === undefined) {
      out += c;
      i += 1;
      continue;
    }
    const end = text.indexOf(close, i + 1);
    if (end >= 0) {
      out += '"…"';
      i = end + 1;
    } else if (OPEN_TO_END.has(c)) {
      return `${out}"…`;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * The message with everything that can name a file, a title, a host or a person taken out:
 * URLs, email addresses, quoted text, IP addresses, `host:port`, ids and tokens; a path hides the
 * rest of the message, a media or image file name its clause. Whitespace collapses; at most 200 characters.
 */
export function scrubMessage(raw: string): string {
  const text = scrubQuotes(
    raw.replace(URL_RE, '<url>').replace(EMAIL_RE, '<email>').replace(TOKEN_RE, '<token>'),
  )
    .replace(UUID_RE, '<id>')
    .replace(IPV6_RE, '<ip>')
    .replace(IPV4_RE, '<ip>')
    .replace(HOST_PORT_RE, '<host>')
    .replace(LONG_ID_RE, '<id>');
  const path = PATH_START_RE.exec(text);
  const scrubbed = hideFiles(path ? `${text.slice(0, path.index)}<path>` : text)
    .replace(/\s+/g, ' ')
    .trim();
  return cut(scrubbed, CLIENT_ERROR_LIMITS.message);
}

/** Clause starts: a file name's title may run back to one of these, never further. */
const CLAUSE_STARTS = [': ', ', ', ' - ', '('];

/**
 * A media or image file name becomes `<file>`, with the words before it back to the start of
 * its clause: in `open Harbor Lights.mkv` the title starts before `.mkv` but nothing says where.
 */
function hideFiles(text: string): string {
  const m = MEDIA_FILE_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index);
  let start = 0;
  for (const d of CLAUSE_STARTS) {
    const i = before.lastIndexOf(d);
    if (i >= 0) start = Math.max(start, i + d.length);
  }
  return `${before.slice(0, start)}<file>${hideFiles(text.slice(m.index + m[0].length))}`;
}

/** At most `max` characters, without a placeholder cut in half at the end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/(?:(?<!…)"|"…|<[a-z]*)$/, '')}…`;
}

/** A class name such as `TypeError`; anything else is `Error`. */
export function scrubName(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z_$][\w$]{0,39}$/.test(raw) ? raw : 'Error';
}

const EXTENSION_RE = /\b(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

/** True for a script from a browser extension, which is not Transcoda's code. */
export function isExtensionSource(text: string): boolean {
  return EXTENSION_RE.test(text);
}

// `at fn (where:1:2)`, `at where:1:2` (V8) and `fn@where:1:2` (Firefox, Safari).
const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const AT_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;
const SCRIPT_PATH = /^\/[\w@.-]+(?:\/[\w@.-]+)*\.(?:m?js|tsx?|jsx)$/;

function scrubFunctionName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (name === '') return '';
  const ok = /^(?:async\s+|new\s+)?[A-Za-z_$<][\w$.<>[\]*/-]*$/.test(name);
  return ok ? name.slice(0, CLIENT_ERROR_LIMITS.functionName) : '?';
}

/** A frame's script as a path on this server (`/assets/index-abc.js`), else `<url>`. */
function scrubWhere(raw: string): string {
  const where = raw.replace(/^async\s+/, '');
  if (where === '<anonymous>' || where === 'native') return where;
  let path: string;
  if (where.startsWith('/')) path = where;
  else {
    try {
      const u = new URL(where);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '<url>';
      path = u.pathname;
    } catch {
      return '<url>';
    }
  }
  path = path.split(/[?#]/)[0] ?? '';
  return SCRIPT_PATH.test(path) ? path : '<url>';
}

/**
 * One stack line as `at fn (/assets/x.js:1:2)`, with the script's host and query dropped; null for
 * a line that is not a frame (the message line, an empty line).
 */
export function scrubFrame(line: string): string | null {
  const m = V8_FRAME.exec(line) ?? AT_FRAME.exec(line);
  if (!m) return null;
  const [, fn, where, row, col] = m;
  if (where === undefined || /\s/.test(where.replace(/^async\s+/, ''))) return null;
  const name = scrubFunctionName(fn);
  const at = `${scrubWhere(where)}:${row}:${col}`;
  return (name === '' ? `at ${at}` : `at ${name} (${at})`).slice(0, CLIENT_ERROR_LIMITS.frame);
}

/** The frames of `stack` (an `Error.stack`), scrubbed, top first. */
export function scrubStack(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = scrubFrame(line);
    if (frame !== null) frames.push(frame);
    if (frames.length === CLIENT_ERROR_LIMITS.frames) break;
  }
  return frames;
}

/** What the browser saw, before scrubbing. */
export interface RawClientError {
  kind: ClientErrorKind;
  route: string;
  version: string;
  name?: unknown;
  message: string;
  stack?: string | undefined;
}

/**
 * Errors that say nothing about Transcoda: the ResizeObserver loop notice, aborted requests,
 * cross-origin `Script error.`, and anything a browser extension threw.
 */
export function isNoise(e: RawClientError): boolean {
  if (/ResizeObserver loop/i.test(e.message)) return true;
  if (e.name === 'AbortError' || /\babort(ed)?\b/i.test(e.message)) return true;
  if (/^Script error\.?$/i.test(e.message.trim()) && !e.stack) return true;
  return isExtensionSource(e.message) || (e.stack !== undefined && isExtensionSource(e.stack));
}

/** The scrubbed event for `e`, or null when it is noise. */
export function clientErrorEvent(e: RawClientError): ClientErrorEvent | null {
  if (isNoise(e)) return null;
  return {
    kind: e.kind,
    route: scrubRoute(e.route),
    version: scrubVersion(e.version),
    name: scrubName(e.name),
    message: scrubMessage(e.message),
    stack: e.stack ? scrubStack(e.stack) : [],
    count: 1,
  };
}

/**
 * The web UI's route patterns (its App.tsx; a test in apps/web checks the two match), literal
 * routes before the ones with a parameter in the same place. A report names one of these, or
 * {@link UNKNOWN_ROUTE}: never the real URL, which holds ids and names.
 */
export const ROUTE_PATTERNS = [
  '/',
  '/setup',
  '/login',
  '/settings/tokens',
  '/settings/about/licences',
  '/settings/:section?/:sub?',
  '/jobs',
  '/jobs/:id',
  '/libraries',
  '/libraries/:id',
  '/libraries/:id/health',
  '/libraries/:id/files/:fileId',
  '/libraries/:id/shows/:show',
  '/libraries/:id/shows/:show/seasons/:season',
  '/recycle',
  '/plugins',
  '/workflows/new',
  '/workflows/:id',
  '/runs/:id',
] as const;

/** Any other path: the Not found page. */
export const UNKNOWN_ROUTE = '/*';

const KNOWN_ROUTES = new Set<string>([...ROUTE_PATTERNS, UNKNOWN_ROUTE]);

/** One of the route patterns, or `<unknown>`. */
export function scrubRoute(raw: string): string {
  return KNOWN_ROUTES.has(raw) ? raw : '<unknown>';
}

/** A version such as `0.9.0` or `0.9.0-dev+abc1234`, or `unknown`. */
export function scrubVersion(raw: string): string {
  return /^[\w.+-]{1,64}$/.test(raw) ? raw : 'unknown';
}

const EventSchema = z
  .object({
    kind: z.enum(CLIENT_ERROR_KINDS),
    route: z.string().max(200),
    version: z.string().max(100),
    name: z.string().max(100),
    message: z.string().max(2000),
    stack: z.array(z.string().max(1000)).max(50),
    count: z.number().int().min(1).max(CLIENT_ERROR_LIMITS.count),
  })
  .strict()
  .transform(
    (e): ClientErrorEvent => ({
      kind: e.kind,
      route: scrubRoute(e.route),
      version: scrubVersion(e.version),
      name: scrubName(e.name),
      message: scrubMessage(e.message),
      stack: e.stack
        .map(scrubFrame)
        .filter((f): f is string => f !== null)
        .slice(0, CLIENT_ERROR_LIMITS.frames),
      count: e.count,
    }),
  );

/**
 * A request's body: the session's CSRF token (sendBeacon cannot set a header) and the events.
 * Parsing scrubs every event again.
 */
export const ClientErrorBatchSchema = z
  .object({
    csrf: z.string().max(200),
    events: z.array(EventSchema).min(1).max(CLIENT_ERROR_LIMITS.batch),
  })
  .strict();
