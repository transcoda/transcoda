// The signed plugin blocklist: a document of "never run this" entries, fetched from beside the
// official catalog, verified with the official keys, cached on disk and matched at install, update
// and before every start. Fail-open on a fetch problem, fail-closed on a positive match: a list
// that cannot be read never blocks anything, a list that names a plugin always does.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_NAME_PATTERN } from '@transcoda/shared';
import semver from 'semver';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { urlSchema } from './catalog.ts';
import { httpFetch } from './http-get.ts';
import { type SigningKey, verifySignature } from './signature.ts';
import { fetchSigned, SignatureError } from './signed-fetch.ts';

/** Largest blocklist body accepted. */
export const MAX_BLOCKLIST_BYTES = 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 3_600_000;

/**
 * Mirrors `scripts/check-blocklist.mjs` in the plugins repo (strict objects, non-blank range,
 * trimmed reason). That script's two content checks, unique ids and `added` not after `generated`,
 * stay CI-only: a list that is merely untidy must still be enforced.
 */
export const BlocklistEntrySchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    name: z.string().regex(PLUGIN_NAME_PATTERN).optional(),
    versions: z
      .string()
      .refine((r) => r.trim() !== '' && semver.validRange(r) !== null, 'not a valid semver range')
      .optional(),
    reason: z.string().refine((r) => r.trim().length >= 1 && r.trim().length <= 200, {
      message: 'reason must be 1-200 characters after trimming',
    }),
    url: urlSchema(false).nullable().default(null),
    added: z.iso.datetime(),
  })
  .refine((e) => e.sha256 !== undefined || e.name !== undefined, {
    message: 'an entry needs sha256 or name',
  })
  .refine((e) => e.versions === undefined || e.name !== undefined, {
    message: 'versions is only allowed together with name',
  });
export type BlocklistEntry = z.infer<typeof BlocklistEntrySchema>;

export const BlocklistSchema = z.strictObject({
  schema: z.literal(1),
  generated: z.iso.datetime(),
  entries: z.array(BlocklistEntrySchema),
});

export interface BlockMatch {
  id: string;
  reason: string;
  url: string | null;
}

/** The first entry that names this build by hash, or by name (and version range, when it has one). */
export function matchBlocklist(
  entries: readonly BlocklistEntry[],
  p: { name: string; version: string; sha256: string },
): BlockMatch | null {
  for (const e of entries) {
    const byHash = e.sha256 !== undefined && e.sha256 === p.sha256;
    const byName =
      e.name !== undefined &&
      e.name === p.name &&
      (e.versions === undefined ||
        semver.satisfies(p.version, e.versions, { includePrerelease: true }));
    if (byHash || byName) return { id: e.id, reason: e.reason.trim(), url: e.url };
  }
  return null;
}

export interface BlocklistStatus {
  error: string | null;
  /** When the entries now in force were fetched (ISO); null when none are loaded. */
  fetchedAt: string | null;
  entries: number;
}

export interface BlocklistClientDeps {
  url: string;
  /** The official slot's keys; null (development `none`) reads the blocklist unsigned. */
  keys: readonly SigningKey[] | null;
  /** `<configDir>/plugins/.catalog`; the cache is `<cacheDir>/blocklist.json`. */
  cacheDir: string;
  token: string | null;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Default 1 h. */
  ttlMs?: number | undefined;
  /** Default 10 s. */
  timeoutMs?: number | undefined;
  /** A `file:` url is read from disk; refused in production. */
  allowFileUrls: boolean;
  log: Logger;
}

interface Parsed {
  entries: BlocklistEntry[];
  generated: string;
}

interface CacheFile {
  fetchedAt: number;
  /** The list's own `generated`: a cache without it is an old format and counts as none. */
  generated: string;
  etag: string | null;
  /** The exact bytes that were verified. */
  body: Buffer;
  sig: string | null;
}

/** A document that verified but is not a blocklist: reported as such, never as a fetch failure. */
class InvalidBlocklist extends Error {}

function describe(err: unknown): string {
  if (err instanceof InvalidBlocklist) return err.message;
  if (err instanceof SignatureError) {
    return err.reason === 'missing'
      ? 'blocklist signature missing'
      : `blocklist signature invalid: ${err.message}`;
  }
  return `blocklist fetch failed: ${err instanceof Error ? err.message : String(err)}`;
}

export class BlocklistClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private entries: BlocklistEntry[] = [];
  /** `generated` of the list in force: an older signed list never replaces it (rollback protection). */
  private generated: string | null = null;
  private fetchedAt: number | null = null;
  private lastAttempt: number | null = null;
  private lastWarn: number | null = null;
  private error: string | null = null;
  private inflight: Promise<BlocklistStatus> | null = null;
  private readonly closing = new AbortController();

  constructor(private readonly deps: BlocklistClientDeps) {
    this.fetchFn = deps.fetchFn ?? httpFetch;
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get url(): string {
    return this.deps.url;
  }

  status(): BlocklistStatus {
    return {
      error: this.error,
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
      entries: this.entries.length,
    };
  }

  /** Aborts a fetch in flight and stops further ones; resolves when nothing is left running. */
  async close(): Promise<void> {
    this.closing.abort();
    await this.inflight?.catch(() => undefined);
  }

  /** Null when nothing is loaded: an unreadable list never blocks. */
  match(p: { name: string; version: string; sha256: string }): BlockMatch | null {
    return matchBlocklist(this.entries, p);
  }

  /** Reads and verifies the cached list from disk, no network. Answers the entries loaded. */
  async loadCache(): Promise<number> {
    const cached = await this.readCache();
    if (cached === null) return 0;
    const parsed = this.parseVerified(cached);
    if (typeof parsed === 'string') return 0;
    this.entries = parsed.entries;
    this.generated = parsed.generated;
    this.fetchedAt = cached.fetchedAt;
    return parsed.entries.length;
  }

  /** A no-op inside the TTL unless `force`. Never throws: a problem is the answer's `error`. */
  refresh(force = false): Promise<BlocklistStatus> {
    if (this.inflight !== null) return this.inflight;
    if (this.closing.signal.aborted) return Promise.resolve(this.status());
    const last = Math.max(this.lastAttempt ?? 0, this.fetchedAt ?? 0);
    if (!force && last > 0 && this.now().getTime() - last < this.ttlMs) {
      return Promise.resolve(this.status());
    }
    const run = this.fetchOnce().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async fetchOnce(): Promise<BlocklistStatus> {
    const nowMs = this.now().getTime();
    this.lastAttempt = nowMs;
    const { url } = this.deps;
    try {
      if (url.startsWith('file:') && !this.deps.allowFileUrls) {
        throw new Error('file: blocklists are not allowed in production');
      }
      // A file: list is already local: it is never cached (and never races a test's cleanup).
      const cached = url.startsWith('file:') ? null : await this.readCache();
      // Only a cache that still verifies may supply the ETag (and answer a 304).
      const usable =
        cached !== null && typeof this.parseVerified(cached) !== 'string' ? cached : null;
      let res: Awaited<ReturnType<typeof fetchSigned>>;
      try {
        res = await this.fetchPair(usable, false);
      } catch (err) {
        // raw.githubusercontent caches the document and its .sig separately for a few minutes.
        if (!(err instanceof SignatureError) || err.reason !== 'mismatch') throw err;
        res = await this.fetchPair(usable, true);
      }
      if (res.status === 304 && usable !== null) {
        await this.writeCache({ ...usable, fetchedAt: nowMs });
        const parsed = this.parseVerified(usable);
        if (typeof parsed === 'string') throw new InvalidBlocklist(parsed);
        return this.accept(parsed, nowMs);
      }
      if (res.body === null) throw new Error(`HTTP ${res.status}`);
      const fresh: CacheFile = {
        fetchedAt: nowMs,
        generated: '',
        etag: res.etag,
        body: res.body,
        sig: res.sigText,
      };
      const parsed = this.parseBody(fresh.body);
      if (typeof parsed === 'string') throw new InvalidBlocklist(parsed);
      fresh.generated = parsed.generated;
      // An old document is validly signed too: replaying one must not lift a block.
      if (this.generated !== null && Date.parse(parsed.generated) < Date.parse(this.generated)) {
        throw new InvalidBlocklist('blocklist older than the list in force');
      }
      if (!url.startsWith('file:')) await this.writeCache(fresh);
      return this.accept(parsed, nowMs);
    } catch (err) {
      return this.failed(describe(err), nowMs);
    }
  }

  private fetchPair(cached: CacheFile | null, noCache: boolean) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (noCache) headers['cache-control'] = 'no-cache';
    else if (cached?.etag != null) headers['if-none-match'] = cached.etag;
    return fetchSigned(
      this.fetchFn,
      this.deps.url,
      {
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), this.closing.signal]),
      },
      this.deps.token,
      MAX_BLOCKLIST_BYTES,
      this.deps.keys,
    );
  }

  private accept(parsed: Parsed, nowMs: number): BlocklistStatus {
    this.entries = parsed.entries;
    this.generated = parsed.generated;
    this.fetchedAt = nowMs;
    this.error = null;
    return this.status();
  }

  /** Fail-open: what was loaded before stays in force. */
  private failed(error: string, nowMs: number): BlocklistStatus {
    this.error = error;
    if (this.lastWarn === null || nowMs - this.lastWarn >= this.ttlMs) {
      this.lastWarn = nowMs;
      this.deps.log.warn({ msg: 'blocklist unavailable', error, kept: this.entries.length });
    }
    return this.status();
  }

  /** Verified (when keys are set) and parsed; a string is the reason it cannot be used. */
  private parseVerified(c: CacheFile): Parsed | string {
    const { keys } = this.deps;
    if (keys !== null && (typeof c.sig !== 'string' || !verifySignature(c.body, c.sig, keys).ok)) {
      return 'cached blocklist does not verify';
    }
    return this.parseBody(c.body);
  }

  private parseBody(body: Buffer): Parsed | string {
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return 'invalid blocklist: not JSON';
    }
    const r = BlocklistSchema.safeParse(json);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return `invalid blocklist: ${where}${issue?.message ?? 'bad shape'}`;
    }
    return { entries: r.data.entries, generated: r.data.generated };
  }

  private get cacheFile(): string {
    return join(this.deps.cacheDir, 'blocklist.json');
  }

  private async readCache(): Promise<CacheFile | null> {
    try {
      const r = z
        .object({
          fetchedAt: z.number(),
          generated: z.string(),
          etag: z.string().nullable(),
          bodyB64: z.string(),
          sig: z.string().nullable().optional(),
        })
        .safeParse(JSON.parse(await readFile(this.cacheFile, 'utf8')));
      if (!r.success) return null;
      return {
        fetchedAt: r.data.fetchedAt,
        generated: r.data.generated,
        etag: r.data.etag,
        body: Buffer.from(r.data.bodyB64, 'base64'),
        sig: r.data.sig ?? null,
      };
    } catch {
      return null;
    }
  }

  private async writeCache(c: CacheFile): Promise<void> {
    try {
      await mkdir(this.deps.cacheDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.cacheFile}.${randomBytes(6).toString('hex')}.tmp`;
      const { body, ...rest } = c;
      await writeFile(tmp, JSON.stringify({ ...rest, bodyB64: body.toString('base64') }), {
        mode: 0o600,
      });
      await rename(tmp, this.cacheFile);
    } catch {
      // the cache is an optimisation; a write failure never fails a refresh
    }
  }
}
