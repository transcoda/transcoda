import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  PLUGIN_NAME_PATTERN,
  type PluginManifest,
  PluginManifestSchema,
  RESERVED_PLUGIN_NAMES,
} from '@transcoda/shared';
import semver from 'semver';
import { httpFetch } from './http-get.ts';
import { type SigningKey, verifySignature } from './signature.ts';
import { MAX_SIGNATURE_BYTES } from './signed-fetch.ts';
import { fetchGuarded, readLimited } from './token-hosts.ts';

export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Why a start is refused when the installed bundle is not the one that was installed. */
export const BUNDLE_CHANGED = 'bundle changed on disk; reinstall';
export const SIGNATURE_MISSING = 'bundle signature missing; reinstall';
export const SIGNATURE_INVALID = 'bundle signature invalid; reinstall';

export interface InstallerDeps {
  pluginsDir: string;
  fetchFn?: typeof fetch;
  token: string | null;
  /** Accept plain http urls (outside production, for local test servers). */
  allowHttp?: boolean | undefined;
  fs?: Pick<
    typeof import('node:fs/promises'),
    | 'mkdir'
    | 'open'
    | 'rename'
    | 'lstat'
    | 'unlink'
    | 'readdir'
    | 'readFile'
    | 'writeFile'
    | 'chmod'
    | 'realpath'
  >;
}

export type DownloadFailure = {
  ok: false;
  reason:
    | 'too-large'
    | 'checksum'
    | 'manifest'
    | 'exists'
    | 'symlink'
    | 'network'
    | 'sdk'
    | 'signature';
  message: string;
};

export interface DownloadRequest {
  name: string;
  version: string;
  url: string;
  manifestUrl: string;
  sha256: string;
  size: number;
  /** Url of the bundle's detached signature; null for a catalog that carries none. */
  signature: string | null;
  /** The keys the bundle must be signed with; null: an unsigned install. */
  keys: readonly SigningKey[] | null;
}

export type DownloadSuccess = {
  ok: true;
  bundlePath: string;
  manifestPath: string;
  manifest: PluginManifest;
  /** Id of the key that verified the bundle; null: installed unsigned. */
  signedBy: string | null;
};

const MAX_VERSION_LENGTH = 64;

class InvalidPluginId extends Error {}

/** A file name `stage` could have written: `.tmp-*` or `<valid name>-<valid version>.js`. */
function isStagedFile(file: string): boolean {
  if (file.startsWith('.tmp-')) return true;
  if (!file.endsWith('.js')) return false;
  const stem = file.slice(0, -3);
  for (let i = stem.indexOf('-'); i !== -1; i = stem.indexOf('-', i + 1)) {
    try {
      assertValidId(stem.slice(0, i), stem.slice(i + 1));
      return true;
    } catch {
      // try the next split: a name or a prerelease version may itself contain '-'
    }
  }
  return false;
}

function assertValidId(name: string, version: string): void {
  if (
    !PLUGIN_NAME_PATTERN.test(name) ||
    (RESERVED_PLUGIN_NAMES as readonly string[]).includes(name)
  ) {
    throw new InvalidPluginId(`invalid plugin name ${JSON.stringify(name.slice(0, 60))}`);
  }
  if (version.length > MAX_VERSION_LENGTH) {
    throw new InvalidPluginId(`plugin version is longer than ${MAX_VERSION_LENGTH} characters`);
  }
  if (semver.valid(version) !== version) {
    throw new InvalidPluginId(`invalid plugin version ${JSON.stringify(version.slice(0, 60))}`);
  }
}

class Failure extends Error {
  constructor(
    readonly reason: DownloadFailure['reason'],
    message: string,
  ) {
    super(message);
  }
}

const BUNDLE_FILE = /^[a-z][a-z0-9-]{0,39}-[0-9A-Za-z.+-]+\.js$/;
const MANIFEST_FILE = /^[a-z][a-z0-9-]{0,39}-[0-9A-Za-z.+-]+\.manifest\.json$/;
const SIG_FILE = /^[a-z][a-z0-9-]{0,39}-[0-9A-Za-z.+-]+\.js\.sig$/;

export class Installer {
  private readonly fs: NonNullable<InstallerDeps['fs']>;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: InstallerDeps) {
    this.fs = deps.fs ?? nodeFs;
    this.fetchFn = deps.fetchFn ?? httpFetch;
  }

  /** mkdir 0700; throws when the directory is a symlink or not a directory. */
  async ensureDir(): Promise<void> {
    const dir = this.deps.pluginsDir;
    const st = await this.fs.lstat(dir).catch(() => null);
    if (st !== null) {
      if (st.isSymbolicLink()) throw new Error(`plugins directory ${dir} is a symlink`);
      if (!st.isDirectory()) throw new Error(`plugins path ${dir} is not a directory`);
      return;
    }
    await this.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.fs.chmod(dir, 0o700);
  }

  bundlePath(name: string, version: string): string {
    return this.target(name, version, `${name}-${version}.js`);
  }

  manifestPath(name: string, version: string): string {
    return this.target(name, version, `${name}-${version}.manifest.json`);
  }

  sigPath(name: string, version: string): string {
    return this.target(name, version, `${name}-${version}.js.sig`);
  }

  /** Validates the identifiers, then refuses any path that is not directly inside pluginsDir. */
  private target(name: string, version: string, file: string): string {
    assertValidId(name, version);
    const path = join(this.deps.pluginsDir, file);
    if (dirname(resolve(path)) !== resolve(this.deps.pluginsDir)) {
      throw new InvalidPluginId(`${file} is outside the plugins directory`);
    }
    return path;
  }

  async download(
    v: DownloadRequest,
    sdkVersion: string,
  ): Promise<DownloadSuccess | DownloadFailure> {
    let bundlePath: string;
    let manifestPath: string;
    let sigPath: string;
    try {
      bundlePath = this.bundlePath(v.name, v.version);
      manifestPath = this.manifestPath(v.name, v.version);
      sigPath = this.sigPath(v.name, v.version);
    } catch (err) {
      return { ok: false, reason: 'manifest', message: (err as Error).message };
    }
    return this.locked(`${v.name}@${v.version}`, () =>
      this.doDownload(v, sdkVersion, bundlePath, manifestPath, sigPath),
    );
  }

  /**
   * The manifest half of `download`: fetched, parsed and checked against the catalog entry and
   * the server's sdk, nothing written. Used by the update pre-check.
   */
  async fetchManifest(
    v: Pick<DownloadRequest, 'name' | 'version' | 'manifestUrl'>,
    sdkVersion: string,
    /** Aborts the request (the catalog gives up on a slow manifest). */
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; manifest: PluginManifest }
    | { ok: false; reason: 'network' | 'manifest'; message: string }
  > {
    try {
      return { ok: true, manifest: await this.loadManifest(v, sdkVersion, signal) };
    } catch (err) {
      if (err instanceof Failure) {
        return {
          ok: false,
          reason: err.reason === 'network' ? 'network' : 'manifest',
          message: err.message,
        };
      }
      return {
        ok: false,
        reason: 'network',
        message: `download failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async loadManifest(
    v: Pick<DownloadRequest, 'name' | 'version' | 'manifestUrl'>,
    sdkVersion: string,
    signal?: AbortSignal,
  ): Promise<PluginManifest> {
    assertValidId(v.name, v.version);
    this.assertUrl(v.manifestUrl);
    return this.parseManifest(
      await this.fetchText(v.manifestUrl, MAX_MANIFEST_BYTES, signal),
      v,
      sdkVersion,
    );
  }

  private assertUrl(u: string): void {
    if (!(u.startsWith('https://') || (this.deps.allowHttp === true && u.startsWith('http://')))) {
      throw new Failure('network', 'plugin urls must be https');
    }
  }

  private async doDownload(
    v: DownloadRequest,
    sdkVersion: string,
    bundlePath: string,
    manifestPath: string,
    sigPath: string,
  ): Promise<DownloadSuccess | DownloadFailure> {
    const tmps: string[] = [];
    try {
      for (const u of [v.url, v.manifestUrl, ...(v.signature === null ? [] : [v.signature])]) {
        this.assertUrl(u);
      }
      try {
        await this.ensureDir();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Failure(/symlink/.test(message) ? 'symlink' : 'network', message);
      }
      await this.assertAbsent(bundlePath);
      await this.assertAbsent(manifestPath);
      await this.assertAbsent(sigPath);
      if (v.size > MAX_BUNDLE_BYTES) {
        throw new Failure(
          'too-large',
          `bundle is ${v.size} bytes, the limit is ${MAX_BUNDLE_BYTES}`,
        );
      }

      if (v.keys !== null && v.signature === null) {
        throw new Failure(
          'signature',
          'the catalog is signed but this version has no bundle signature',
        );
      }
      const manifestText = await this.fetchText(v.manifestUrl, MAX_MANIFEST_BYTES);
      const manifest = this.parseManifest(manifestText, v, sdkVersion);
      const sigText = v.keys === null ? null : await this.fetchSignature(v.signature as string);

      const tmpBundle = join(this.deps.pluginsDir, `.tmp-${randomBytes(8).toString('hex')}`);
      tmps.push(tmpBundle);
      await this.streamBundle(v, tmpBundle);
      let signedBy: string | null = null;
      if (v.keys !== null && sigText !== null) {
        // The signature is over the bytes, not over the sha256: read the stored copy back.
        const bytes = await this.fs.readFile(tmpBundle);
        if (bytes.byteLength > MAX_BUNDLE_BYTES) {
          throw new Failure('too-large', `bundle is larger than ${MAX_BUNDLE_BYTES} bytes`);
        }
        const check = verifySignature(bytes, sigText, v.keys);
        if (!check.ok) {
          throw new Failure('signature', `bundle signature invalid: ${check.message}`);
        }
        signedBy = check.keyId;
      }

      const tmpManifest = join(this.deps.pluginsDir, `.tmp-${randomBytes(8).toString('hex')}`);
      tmps.push(tmpManifest);
      const mh = await this.fs.open(tmpManifest, 'wx', 0o600);
      try {
        await mh.writeFile(manifestText);
        await mh.sync();
      } finally {
        await mh.close();
      }

      let tmpSig: string | null = null;
      if (sigText !== null) {
        tmpSig = join(this.deps.pluginsDir, `.tmp-${randomBytes(8).toString('hex')}`);
        tmps.push(tmpSig);
        const sh = await this.fs.open(tmpSig, 'wx', 0o600);
        try {
          await sh.writeFile(sigText);
          await sh.sync();
        } finally {
          await sh.close();
        }
      }

      await this.assertAbsent(bundlePath);
      await this.assertAbsent(manifestPath);
      await this.assertAbsent(sigPath);
      // manifest first: a crash in between leaves an orphan manifest, which audit() reports and
      // which never loads (no bundle); the reverse order would leave a bundle without a manifest.
      await this.fs.rename(tmpManifest, manifestPath);
      tmps.splice(tmps.indexOf(tmpManifest), 1);
      try {
        // order: manifest, signature, bundle. A signature without a bundle is an orphan audit()
        // reports; a bundle is never visible before its signature.
        if (tmpSig !== null) {
          await this.fs.rename(tmpSig, sigPath);
          tmps.splice(tmps.indexOf(tmpSig), 1);
        }
        await this.fs.rename(tmpBundle, bundlePath);
        tmps.splice(tmps.indexOf(tmpBundle), 1);
      } catch (err) {
        await this.fs.unlink(manifestPath).catch(() => undefined);
        await this.fs.unlink(sigPath).catch(() => undefined);
        throw err;
      }
      await this.syncDir();
      return { ok: true, bundlePath, manifestPath, manifest, signedBy };
    } catch (err) {
      for (const t of tmps) await this.fs.unlink(t).catch(() => undefined);
      if (err instanceof Failure) return { ok: false, reason: err.reason, message: err.message };
      return {
        ok: false,
        reason: 'network',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async remove(name: string, version: string): Promise<void> {
    const paths = [
      this.bundlePath(name, version),
      this.manifestPath(name, version),
      this.sigPath(name, version),
    ];
    await this.locked(`${name}@${version}`, async () => {
      for (const p of paths) {
        await this.fs.unlink(p).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    });
  }

  private readonly locks = new Map<string, Promise<unknown>>();

  /** Serialises operations on one name@version so two installs cannot interleave. */
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private async syncDir(): Promise<void> {
    try {
      const h = await this.fs.open(this.deps.pluginsDir, 'r');
      try {
        await h.sync();
      } finally {
        await h.close();
      }
    } catch {
      // directory fsync is best effort (not supported on every platform)
    }
  }

  /** Regular files that look like installed plugin files (`.tmp-*` leftovers excluded). */
  async listInstalledFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const name of await this.readdir()) {
      if (!BUNDLE_FILE.test(name) && !MANIFEST_FILE.test(name) && !SIG_FILE.test(name)) continue;
      const st = await this.fs.lstat(join(this.deps.pluginsDir, name)).catch(() => null);
      if (st?.isFile()) out.push(name);
    }
    return out.sort();
  }

  async audit(): Promise<string[]> {
    const msgs: string[] = [];
    const names = await this.readdir();
    const bundles = new Set<string>();
    const manifests = new Set<string>();
    const sigs = new Set<string>();
    for (const name of names) {
      if (BUNDLE_FILE.test(name)) bundles.add(name.slice(0, -'.js'.length));
      else if (MANIFEST_FILE.test(name)) manifests.add(name.slice(0, -'.manifest.json'.length));
      else if (SIG_FILE.test(name)) sigs.add(name.slice(0, -'.js.sig'.length));
    }
    for (const b of bundles) {
      if (!manifests.has(b)) msgs.push(`${b}.js has no manifest and will not be loaded`);
    }
    for (const m of manifests) {
      if (!bundles.has(m)) msgs.push(`${m}.manifest.json has no bundle`);
    }
    for (const g of sigs) {
      if (!bundles.has(g)) msgs.push(`${g}.js.sig has no bundle`);
    }
    for (const name of names) {
      if (name.startsWith('.catalog')) continue;
      const st = await this.fs.lstat(join(this.deps.pluginsDir, name)).catch(() => null);
      if (st === null) continue;
      if (st.isSymbolicLink()) msgs.push(`${name} is a symlink and will not be loaded`);
      else if (st.isDirectory()) msgs.push(`${name} is a directory and will not be loaded`);
      else if (!st.isFile()) msgs.push(`${name} is not a regular file and will not be loaded`);
      else if (name.startsWith('.tmp-')) {
        await this.fs.unlink(join(this.deps.pluginsDir, name)).catch(() => undefined);
        msgs.push(`${name} was a leftover temporary file and has been removed`);
      } else if (!BUNDLE_FILE.test(name) && !MANIFEST_FILE.test(name) && !SIG_FILE.test(name)) {
        msgs.push(`${name} is not a plugin file and will not be loaded`);
      }
    }
    return msgs;
  }

  async readManifest(name: string, version: string): Promise<PluginManifest> {
    const text = await this.fs.readFile(this.manifestPath(name, version), 'utf8');
    const manifest = PluginManifestSchema.parse(JSON.parse(text));
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(
        `manifest file ${name}-${version} describes ${manifest.name}@${manifest.version}`,
      );
    }
    return manifest;
  }

  /**
   * Re-hash the bundle before every start. The bytes that were hashed come back, so whatever runs
   * (or is staged for the plugin user) is exactly what was verified, not a second read of the file.
   */
  async verifyInstalled(
    name: string,
    version: string,
    sha256: string,
    keys: readonly SigningKey[] | null,
  ): Promise<{ ok: true; bytes: Buffer; keyId: string | null } | { ok: false; reason: string }> {
    const path = this.bundlePath(name, version);
    let bytes: Buffer;
    try {
      const st = await this.fs.lstat(path);
      if (!st.isFile()) return { ok: false, reason: BUNDLE_CHANGED };
      bytes = await this.fs.readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        return { ok: false, reason: BUNDLE_CHANGED };
      }
    } catch {
      return { ok: false, reason: BUNDLE_CHANGED };
    }
    if (keys === null) return { ok: true, bytes, keyId: null };
    // A signed install is never started on its checksum alone.
    let sigText: string;
    try {
      const sigPath = this.sigPath(name, version);
      const st = await this.fs.lstat(sigPath);
      if (!st.isFile() || st.size > MAX_SIGNATURE_BYTES)
        return { ok: false, reason: SIGNATURE_INVALID };
      sigText = await this.fs.readFile(sigPath, 'utf8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return { ok: false, reason: missing ? SIGNATURE_MISSING : SIGNATURE_INVALID };
    }
    const check = verifySignature(bytes, sigText, keys);
    if (check.ok) return { ok: true, bytes, keyId: check.keyId };
    if (check.reason === 'unknown-key') {
      return { ok: false, reason: `${check.message}; update the plugin` };
    }
    return { ok: false, reason: SIGNATURE_INVALID };
  }

  /**
   * Writes `bytes` to `<runDir>/<name>-<version>.js` (the plugin user's readable copy: the plugin
   * group can read it, `/config` it cannot) and returns the real path, which is what the sandbox's
   * read grant must name. Exclusive temporary file, then rename: an existing copy is replaced
   * atomically and a running host keeps the file it already imported.
   */
  async stage(name: string, version: string, bytes: Buffer, runDir: string): Promise<string> {
    assertValidId(name, version);
    const target = join(runDir, `${name}-${version}.js`);
    const tmp = join(runDir, `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      const handle = await this.fs.open(tmp, 'wx', 0o640);
      try {
        await handle.writeFile(bytes);
        // The umask may have narrowed the mode: the plugin group must be able to read it.
        await handle.chmod(0o640);
      } finally {
        await handle.close();
      }
      await this.fs.rename(tmp, target);
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    return this.fs.realpath(target);
  }

  /** Best effort: the staged copy of one version goes away. */
  async unstage(name: string, version: string, runDir: string): Promise<void> {
    try {
      assertValidId(name, version);
      await this.fs.unlink(join(runDir, `${name}-${version}.js`));
    } catch {
      // already gone, never staged or the run dir is unusable: nothing to undo
    }
  }

  /**
   * At start: nothing staged by an earlier run stays. Best effort, and only files `stage` makes
   * (`<name>-<version>.js`, `.tmp-*`); anything else in the directory is left alone.
   */
  async cleanRunDir(runDir: string): Promise<void> {
    const names = await this.fs.readdir(runDir).catch(() => [] as string[]);
    for (const n of names) {
      if (!isStagedFile(n)) continue;
      await this.fs.unlink(join(runDir, n)).catch(() => undefined);
    }
  }

  private async readdir(): Promise<string[]> {
    return this.fs.readdir(this.deps.pluginsDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
  }

  private async assertAbsent(path: string): Promise<void> {
    const st = await this.fs.lstat(path).catch(() => null);
    if (st === null) return;
    if (!st.isFile()) throw new Failure('symlink', `${path} exists and is not a regular file`);
    throw new Failure('exists', `${path} already exists`);
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    const timeout = AbortSignal.timeout(120_000);
    try {
      res = await fetchGuarded(
        this.fetchFn,
        url,
        { signal: signal ? AbortSignal.any([timeout, signal]) : timeout },
        this.deps.token,
      );
    } catch (err) {
      throw new Failure(
        'network',
        `download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      throw new Failure('network', `download failed: HTTP ${res.status}`);
    }
    return res;
  }

  private async fetchText(url: string, limit: number, signal?: AbortSignal): Promise<string> {
    const res = await this.get(url, signal);
    const bytes = await readLimited(res, limit);
    if (bytes === null) throw new Failure('manifest', 'manifest is too large');
    return bytes.toString('utf8');
  }

  /** The bundle's signature file: a 4xx is "missing", anything else wrong is a fetch failure. */
  private async fetchSignature(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchGuarded(
        this.fetchFn,
        url,
        { signal: AbortSignal.timeout(60_000) },
        this.deps.token,
      );
    } catch (err) {
      throw new Failure(
        'network',
        `download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 500) throw new Failure('network', `download failed: HTTP ${res.status}`);
      throw new Failure(
        'signature',
        `bundle signature invalid: signature missing (HTTP ${res.status})`,
      );
    }
    const bytes = await readLimited(res, MAX_SIGNATURE_BYTES);
    if (bytes === null) {
      throw new Failure(
        'signature',
        `bundle signature invalid: malformed signature file: larger than ${MAX_SIGNATURE_BYTES} bytes`,
      );
    }
    return bytes.toString('utf8');
  }

  private parseManifest(
    text: string,
    v: Pick<DownloadRequest, 'name' | 'version'>,
    sdkVersion: string,
  ): PluginManifest {
    let manifest: PluginManifest;
    try {
      manifest = PluginManifestSchema.parse(JSON.parse(text));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Failure('manifest', `invalid manifest: ${detail.slice(0, 200)}`);
    }
    if (manifest.name !== v.name || manifest.version !== v.version) {
      throw new Failure(
        'manifest',
        `manifest is for ${manifest.name}@${manifest.version}, expected ${v.name}@${v.version}`,
      );
    }
    if (!semver.satisfies(sdkVersion, manifest.sdk, { includePrerelease: true })) {
      throw new Failure(
        'sdk',
        `sdk ${manifest.sdk} is not supported by this server (sdk ${sdkVersion})`,
      );
    }
    return manifest;
  }

  private async streamBundle(v: DownloadRequest, tmp: string): Promise<void> {
    const limit = Math.min(MAX_BUNDLE_BYTES, v.size);
    const res = await this.get(v.url);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > limit) {
      await res.body?.cancel().catch(() => undefined);
      throw new Failure('too-large', `bundle is larger than the declared ${v.size} bytes`);
    }
    const hash = createHash('sha256');
    const handle = await this.fs.open(tmp, 'wx', 0o600);
    let total = 0;
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new Failure('too-large', `bundle is larger than the declared ${v.size} bytes`);
        }
        hash.update(value);
        await handle.write(value);
      }
      const got = hash.digest('hex');
      if (got !== v.sha256) {
        throw new Failure('checksum', `checksum mismatch: expected ${v.sha256}, got ${got}`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
