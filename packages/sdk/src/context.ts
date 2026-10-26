import {
  FETCH_ERROR_KINDS,
  type FetchErrorKind,
  iso1Of,
  type JsonValue,
  languageFromName,
  normalizeLanguage,
  normalizeLanguageValue,
  type PathMapping,
} from '@transcoda/shared';

export interface PluginFetchInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | JsonValue | undefined;
  timeoutMs?: number | undefined;
  accept?: 'json' | 'text' | 'none' | undefined;
  /** Applied by the server with the real secret values; prefer it over building a header yourself. */
  auth?:
    | { basic: { username: string; password: string } }
    | { bearer: string }
    | { header: { name: string; value: string } }
    | { query: { name: string; value: string } }
    | undefined;
}

export interface PluginFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: JsonValue;
}

/** Base of the four fetch failures; `kind` matches `FETCH_ERROR_KINDS`. */
export abstract class FetchError extends Error {
  abstract readonly kind: FetchErrorKind;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class FetchRefused extends FetchError {
  readonly kind = 'refused' as const;
}
export class FetchTimeout extends FetchError {
  readonly kind = 'timeout' as const;
}
export class FetchRateLimited extends FetchError {
  readonly kind = 'rate-limited' as const;
}
export class FetchFailed extends FetchError {
  readonly kind = 'failed' as const;
}

const FETCH_KINDS: readonly string[] = FETCH_ERROR_KINDS;

/**
 * The fetch failure kind of an error thrown by `ctx.fetch`, or `null` for any other error.
 * Goes by the `kind` property, never `instanceof`: the host and each plugin bundle inline their own copy of the SDK.
 */
export function fetchErrorKind(e: unknown): FetchErrorKind | null {
  if (typeof e !== 'object' || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === 'string' && FETCH_KINDS.includes(kind) ? (kind as FetchErrorKind) : null;
}

export interface PluginPaths {
  /** Transcoda's (local) path → the path the service sees. */
  toRemote(localPath: string): string;
  /** The service's path → Transcoda's (local) path. */
  toLocal(remotePath: string): string;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

function mapPrefix(original: string, pairs: Array<[from: string, to: string]>): string {
  const path = trimSlash(original);
  let best: [string, string] | null = null;
  for (const pair of pairs) {
    const [from] = pair;
    const matches = from === '/' || path === from || path.startsWith(`${from}/`);
    if (matches && (best === null || from.length > best[0].length)) best = pair;
  }
  if (best === null) return original;
  const rest = best[0] === '/' ? (path === '/' ? '' : path) : path.slice(best[0].length);
  return best[1] === '/' ? rest || '/' : `${best[1]}${rest}`;
}

/** Longest prefix wins and only whole path segments match; nothing matching leaves the path alone. */
export function createPaths(mappings: PathMapping[]): PluginPaths {
  const norm = mappings.map((m) => ({ remote: trimSlash(m.remote), local: trimSlash(m.local) }));
  const toRemote = norm.map((m): [string, string] => [m.local, m.remote]);
  const toLocal = norm.map((m): [string, string] => [m.remote, m.local]);
  return {
    toRemote: (p) => mapPrefix(p, toRemote),
    toLocal: (p) => mapPrefix(p, toLocal),
  };
}

export interface PluginCache {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue, ttlMs: number): Promise<void>;
}

/** LRU by insertion order; an entry's size is the length of its JSON; expired entries drop on `get`. */
export function createCache(
  limits: { entries: number; bytes: number },
  now: () => number = Date.now,
): PluginCache {
  const map = new Map<string, { value: JsonValue; expires: number; size: number }>();
  let total = 0;
  const drop = (key: string) => {
    const e = map.get(key);
    if (e) {
      total -= e.size;
      map.delete(key);
    }
  };
  return {
    async get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expires <= now()) {
        drop(key);
        return undefined;
      }
      return structuredClone(e.value);
    },
    async set(key, value, ttlMs) {
      const size = JSON.stringify(value).length;
      drop(key);
      if (size > limits.bytes || limits.entries < 1) return;
      map.set(key, { value: structuredClone(value), expires: now() + ttlMs, size });
      total += size;
      while (map.size > limits.entries || total > limits.bytes) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    },
  };
}

export interface PluginLang {
  /** 'Japanese' → 'ja' (ISO 639-1 when there is one, else the 639-2 code); unknown name → null. */
  fromName(name: string): string | null;
  toIso3(code: string): string | null;
  normalise(value: unknown): string | 'unknown';
}

export const lang: PluginLang = {
  fromName(name) {
    const iso3 = languageFromName(name);
    return iso1Of(iso3) ?? iso3;
  },
  toIso3: (code) => normalizeLanguage(code),
  normalise: (value) => normalizeLanguageValue(value),
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PluginContext {
  /** The integration settings, decrypted; `{}` when the plugin has no integration. */
  settings: Record<string, JsonValue>;
  fetch(input: PluginFetchInput): Promise<PluginFetchResponse>;
  paths: PluginPaths;
  cache: PluginCache;
  lang: PluginLang;
  log(level: LogLevel, message: string): Promise<void>;
  dryRun: boolean;
  job: { id: string; attempt: number } | null;
}

/** What core nodes get: no settings, no network, identity paths, no cache. */
export function corePluginContext(
  opts: { dryRun?: boolean; job?: PluginContext['job'] } = {},
): PluginContext {
  return {
    settings: {},
    async fetch() {
      throw new FetchRefused('core nodes have no integration');
    },
    paths: createPaths([]),
    cache: createCache({ entries: 0, bytes: 0 }),
    lang,
    async log() {},
    dryRun: opts.dryRun ?? false,
    job: opts.job ?? null,
  };
}
