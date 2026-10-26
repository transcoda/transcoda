import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_NAME_PATTERN } from '@transcoda/shared';
import semver from 'semver';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { httpFetch } from './http-get.ts';
import { type SigningKey, verifySignature } from './signature.ts';
import { fetchSigned, SignatureError } from './signed-fetch.ts';

export { OFFICIAL_CATALOG_URL } from './catalog-url.ts';
export { CATALOG_TOKEN_HOSTS, tokenAllowedFor } from './token-hosts.ts';

/** Largest catalog index body accepted. */
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

const semverString = z.string().refine((v) => semver.valid(v) === v, 'not a semver version');
export function urlSchema(allowInsecure: boolean) {
  return z
    .url()
    .refine(
      (u) => u.startsWith('https://') || (allowInsecure && u.startsWith('http://')),
      'url must be https',
    );
}

/** Catalog urls are https; plain http only when `allowInsecure` (outside production). */
export function catalogIndexSchema(allowInsecure: boolean) {
  const httpsUrl = urlSchema(allowInsecure);
  return z.object({
    schema: z.literal(1),
    generated: z.iso.datetime(),
    plugins: z.array(
      z.object({
        name: z.string().regex(PLUGIN_NAME_PATTERN),
        title: z.string(),
        description: z.string(),
        latest: semverString,
        versions: z.array(
          z.object({
            version: semverString,
            sdk: z.string(),
            coreTested: z.array(z.string()),
            url: httpsUrl,
            manifestUrl: httpsUrl,
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            size: z.number().int().positive(),
            attestation: httpsUrl.nullable(),
            /** Detached signature of the bundle; null for catalogs that predate signing. */
            signature: httpsUrl.nullable().default(null),
            releasedAt: z.iso.datetime(),
          }),
        ),
      }),
    ),
  });
}
export const CatalogIndexSchema = catalogIndexSchema(false);
export type CatalogVersion = z.infer<
  typeof CatalogIndexSchema
>['plugins'][number]['versions'][number];
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

export interface CatalogEntry {
  catalogUrl: string;
  name: string;
  title: string;
  description: string;
  latest: string;
  /** The catalog is verified against signing keys (false: an unsigned catalog). */
  signed: boolean;
  versions: Array<CatalogVersion & { compatible: boolean }>;
}

export interface CatalogClientDeps {
  sdkVersion: string;
  token: string | null;
  /** `<configDir>/plugins/.catalog` */
  cacheDir: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** Default 10 s. */
  timeoutMs?: number | undefined;
  /** Default 1 h. */
  ttlMs?: number | undefined;
  /** A `file:` catalog url is read from disk; refused in production. */
  allowFileUrls: boolean;
  /** The keys a catalog must be signed with; null: unsigned (custom catalogs without a pinned key). */
  keysFor(url: string): readonly SigningKey[] | null;
  /** Warned when a verified index older than the cached one is refused. */
  log?: Pick<Logger, 'warn'> | undefined;
}

interface Loaded {
  index: CatalogIndex | null;
  error: string | null;
  fetchedAt: number | null;
}

interface CacheFile {
  fetchedAt: number;
  etag: string | null;
  /** The exact bytes that were verified (stored as `bodyB64`). */
  body: Buffer;
  /** The verbatim `.sig` file the body was verified with; null/absent: written unsigned. */
  sig?: string | null | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 3_600_000;

export class CatalogClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly schema: ReturnType<typeof catalogIndexSchema>;

  constructor(private readonly deps: CatalogClientDeps) {
    this.fetchFn = deps.fetchFn ?? httpFetch;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.schema = catalogIndexSchema(deps.allowFileUrls);
  }

  async list(
    urls: string[],
    opts: { refresh?: boolean } = {},
  ): Promise<{
    entries: CatalogEntry[];
    errors: Array<{ catalogUrl: string; message: string }>;
    /** One row per requested url: when its index was last fetched (ISO), null when never. */
    catalogs: Array<{ catalogUrl: string; fetchedAt: string | null }>;
  }> {
    const catalogs: Array<{ catalogUrl: string; fetchedAt: string | null }> = [];
    const entries: CatalogEntry[] = [];
    const errors: Array<{ catalogUrl: string; message: string }> = [];
    const results = await Promise.all(urls.map((url) => this.load(url, opts.refresh === true)));
    urls.forEach((catalogUrl, i) => {
      const r = results[i];
      if (r === undefined) return;
      catalogs.push({
        catalogUrl,
        fetchedAt: r.fetchedAt === null ? null : new Date(r.fetchedAt).toISOString(),
      });
      if (r.error !== null) errors.push({ catalogUrl, message: r.error });
      if (r.index === null) return;
      for (const p of r.index.plugins) {
        entries.push({
          catalogUrl,
          name: p.name,
          title: p.title,
          description: p.description,
          latest: p.latest,
          signed: this.deps.keysFor(catalogUrl) !== null,
          versions: p.versions.map((v) => ({
            ...v,
            compatible: semver.satisfies(this.deps.sdkVersion, v.sdk, {
              includePrerelease: true,
            }),
          })),
        });
      }
    });
    return { entries, errors, catalogs };
  }

  async find(
    urls: string[],
    name: string,
    version: string,
    opts: { refresh?: boolean } = {},
  ): Promise<(CatalogVersion & { catalogUrl: string }) | null> {
    const { entries } = await this.list(urls, opts);
    for (const e of entries) {
      if (e.name !== name) continue;
      const v = e.versions.find((x) => x.version === version);
      if (v !== undefined) {
        const { compatible: _compatible, ...rest } = v;
        return { ...rest, catalogUrl: e.catalogUrl };
      }
    }
    return null;
  }

  private async load(url: string, refresh: boolean): Promise<Loaded> {
    if (url.startsWith('file:')) return this.loadFile(url);
    const keys = this.deps.keysFor(url);
    const cacheFile = join(
      this.deps.cacheDir,
      `${createHash('sha1').update(url).digest('hex')}.json`,
    );
    // With keys, a cache entry counts only when its body still verifies against its stored
    // signature: a cache written before signing, or a tampered one, is no cache at all.
    let cached = await this.readCache(cacheFile);
    if (cached !== null && keys !== null && !this.cacheVerifies(cached, keys)) cached = null;
    const nowMs = this.now().getTime();
    if (cached !== null && !refresh && nowMs - cached.fetchedAt < this.ttlMs) {
      const parsed = this.parse(cached.body.toString('utf8'), cached.fetchedAt);
      if (parsed.index !== null) return parsed;
    }
    let fetchError: string;
    try {
      let res: Awaited<ReturnType<typeof fetchSigned>>;
      try {
        res = await this.fetchPair(url, keys, cached, false);
      } catch (err) {
        // raw.githubusercontent caches the index and its .sig separately for a few minutes, so
        // right after a catalog push they can disagree: one retry past the cache.
        if (!(err instanceof SignatureError) || err.reason !== 'mismatch') throw err;
        res = await this.fetchPair(url, keys, cached, true);
      }
      if (res.status === 304 && cached !== null) {
        await this.writeCache(cacheFile, { ...cached, fetchedAt: nowMs });
        return this.parse(cached.body.toString('utf8'), nowMs);
      }
      if (res.body === null) throw new Error(`HTTP ${res.status}`);
      const body = res.body;
      const parsed = this.parse(body.toString('utf8'), nowMs);
      const stale = keys !== null ? this.olderThanCache(parsed.index, cached) : null;
      if (parsed.index === null) {
        fetchError = parsed.error ?? 'invalid catalog';
      } else if (stale !== null) {
        // An old index is validly signed too: replaying one must not hide an update.
        fetchError = stale;
        this.deps.log?.warn({ msg: 'refused a catalog index older than the cached one', url });
      } else {
        await this.writeCache(cacheFile, {
          fetchedAt: nowMs,
          etag: res.etag,
          body,
          sig: res.sigText,
        });
        return parsed;
      }
    } catch (err) {
      if (err instanceof SignatureError) {
        fetchError = signatureMessage(err);
        // Only a disagreement that survives the retry may fall back, and only to the last
        // verified index. A missing, malformed or unknown-key signature never does.
        if (err.reason !== 'mismatch') return { index: null, error: fetchError, fetchedAt: null };
      } else {
        fetchError = `catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (cached !== null) {
      const parsed = this.parse(cached.body.toString('utf8'), cached.fetchedAt);
      if (parsed.index !== null) {
        return { index: parsed.index, error: fetchError, fetchedAt: cached.fetchedAt };
      }
    }
    return { index: null, error: fetchError, fetchedAt: null };
  }

  private fetchPair(
    url: string,
    keys: readonly SigningKey[] | null,
    cached: CacheFile | null,
    noCache: boolean,
  ) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (noCache) headers['cache-control'] = 'no-cache';
    else if (cached?.etag != null) headers['if-none-match'] = cached.etag;
    return fetchSigned(
      this.fetchFn,
      url,
      { headers, signal: AbortSignal.timeout(this.timeoutMs) },
      this.deps.token,
      MAX_CATALOG_BYTES,
      keys,
    );
  }

  /** The refusal message when `index` is older than the (verified) cached index, else null. */
  private olderThanCache(index: CatalogIndex | null, cached: CacheFile | null): string | null {
    if (index === null || cached === null) return null;
    const prev = this.parse(cached.body.toString('utf8')).index;
    if (prev === null || Date.parse(index.generated) >= Date.parse(prev.generated)) return null;
    return `catalog index older than the cached one (generated ${index.generated}, cached ${prev.generated})`;
  }

  private cacheVerifies(cached: CacheFile, keys: readonly SigningKey[]): boolean {
    return typeof cached.sig === 'string' && verifySignature(cached.body, cached.sig, keys).ok;
  }

  private async loadFile(url: string): Promise<Loaded> {
    if (!this.deps.allowFileUrls) {
      return {
        index: null,
        error: 'file: catalogs are not allowed in production',
        fetchedAt: null,
      };
    }
    try {
      const res = await fetchSigned(
        this.fetchFn,
        url,
        {},
        null,
        MAX_CATALOG_BYTES,
        this.deps.keysFor(url),
      );
      return this.parse((res.body ?? Buffer.alloc(0)).toString('utf8'), this.now().getTime());
    } catch (err) {
      if (err instanceof SignatureError) {
        return { index: null, error: signatureMessage(err), fetchedAt: null };
      }
      return {
        index: null,
        error: `catalog read failed: ${err instanceof Error ? err.message : String(err)}`,
        fetchedAt: null,
      };
    }
  }

  private async readCache(file: string): Promise<CacheFile | null> {
    try {
      const v: unknown = JSON.parse(await readFile(file, 'utf8'));
      const r = z
        .object({
          fetchedAt: z.number(),
          etag: z.string().nullable(),
          bodyB64: z.string(),
          sig: z.string().nullable().optional(),
        })
        .safeParse(v);
      if (!r.success) return null;
      const { bodyB64, ...rest } = r.data;
      return { ...rest, body: Buffer.from(bodyB64, 'base64') };
    } catch {
      return null;
    }
  }

  private async writeCache(file: string, c: CacheFile): Promise<void> {
    try {
      await mkdir(this.deps.cacheDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      const { body, ...rest } = c;
      await writeFile(tmp, JSON.stringify({ ...rest, bodyB64: body.toString('base64') }), {
        mode: 0o600,
      });
      await rename(tmp, file);
    } catch {
      // the cache is an optimisation; a write failure never fails a listing
    }
  }

  private parse(body: string, fetchedAt: number | null = null): Loaded {
    try {
      const r = this.schema.safeParse(JSON.parse(body));
      if (r.success) return { index: r.data, error: null, fetchedAt };
      return {
        index: null,
        error: `invalid catalog: ${r.error.issues[0]?.message ?? 'bad shape'}`,
        fetchedAt,
      };
    } catch {
      return { index: null, error: 'invalid catalog: not JSON', fetchedAt };
    }
  }
}

function signatureMessage(err: SignatureError): string {
  return err.reason === 'missing'
    ? 'catalog signature missing'
    : `catalog signature invalid: ${err.message}`;
}
