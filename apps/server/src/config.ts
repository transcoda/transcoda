import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_BLOCKLIST_URL, OFFICIAL_CATALOG_URL } from './plugins/catalog-url.ts';
import { OFFICIAL_SIGNING_KEYS } from './plugins/official-keys.ts';
import { parseSigningKeys, type SigningKey } from './plugins/signature.ts';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** How plugin hosts are started as another user (Linux, entrypoint-prepared); null runs them as the server's user. */
export interface PluginIsolation {
  uid: number;
  gid: number;
  /** Where bundles are staged for the plugin user (a tmpfs the plugin group can read). */
  runDir: string;
  setprivPath: string;
}

export interface Config {
  port: number;
  host: string;
  configDir: string;
  transcodeDir: string;
  allowedHosts: string[];
  /** TRANSCODA_PUBLIC_URL: the origin users reach the UI by (no path, no trailing slash), for links in notifications; null when unset. */
  publicUrl: string | null;
  trustedProxies: string[];
  secretKeyHex: string | null;
  /** TRANSCODA_BUILD_ID (image build-arg): identifies the build; null → a hash of the running server file. */
  buildId: string | null;
  ffmpegPath: string;
  /** Defaults to `ffprobe` beside `ffmpegPath` when that has a directory part. */
  ffprobePath: string;
  /** Absolute roots an output node may write under (none by default). */
  outputRoots: string[];
  /** linuxserver.io-style owner for files the engine writes; null when unset. */
  puid: number | null;
  pgid: number | null;
  webDistDir: string | null;
  nodeEnv: 'production' | 'development' | 'test';
  /** `${configDir}/plugins`: installed bundles and manifests. */
  pluginsDir: string;
  /** TRANSCODA_PLUGIN_HOST; default `plugin-host.js` beside the running entry (`pnpm dev` sets it). */
  pluginHostPath: string;
  /** TRANSCODA_PLUGIN_CATALOG_URL; default the official catalog. */
  pluginCatalogUrl: string;
  /**
   * TRANSCODA_PLUGIN_CATALOG_KEY: keys the official catalog must be signed by. Unset: the pinned
   * official keys (possibly none); `none`: unsigned (never in production); else `<id>:<hex>,...`.
   */
  pluginCatalogKeys: SigningKey[] | null;
  /** TRANSCODA_PLUGIN_BLOCKLIST_URL; default the official blocklist. */
  pluginBlocklistUrl: string;
  /** TRANSCODA_CATALOG_TOKEN: sent only to the hosts catalog.ts allows. */
  catalogToken: string | null;
  /** TRANSCODA_DEV_PLUGINS: absolute bundle paths, never in production. */
  devPlugins: string[];
  /** TRANSCODA_PLUGIN_INSPECT=1: hosts start with an inspector, never in production. */
  pluginInspect: boolean;
  /** TRANSCODA_PLUGIN_UID/GID (set by the image's entrypoint): hosts run as that user; null when unset. */
  pluginIsolation: PluginIsolation | null;
  /** TRANSCODA_PLUGIN_ISOLATION=off: run plugins as the server user on purpose (production only needs it then). */
  pluginIsolationOff: boolean;
  /** TRANSCODA_HEALTH_STALL_HOURS (default 6): a running job with no progress for this long fails the deep health queue check. */
  healthStallHours: number;
  /**
   * TRANSCODA_ENCODE_STALL_MINUTES (default 60; 0 turns it off): an encode whose ffmpeg writes no
   * more output for this long (paused time excluded) is stopped and the job fails.
   */
  encodeStallMinutes: number;
  /** TRANSCODA_HEALTH_MIN_FREE_GIB (default 5): the deep health scratch-space check needs at least max(5, this). */
  healthMinFreeGiB: number;
  /** TRANSCODA_UPDATE_CHECK (default true): false never asks GitHub whether a newer release exists. */
  updateCheck: boolean;
}

function parsePositive(
  name: string,
  unit: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!(n > 0) || !Number.isFinite(n)) {
    throw new ConfigError(`${name} must be a positive number of ${unit}, got "${value}"`);
  }
  return n;
}

/** Like parsePositive, but 0 is allowed (it turns the setting off). */
function parseNonNegative(
  name: string,
  unit: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value !== undefined && /^0+(\.0+)?$/.test(value.trim())) return 0;
  try {
    return parsePositive(name, unit, value, fallback);
  } catch {
    throw new ConfigError(
      `${name} must be 0 (off) or a positive number of ${unit}, got "${value}"`,
    );
  }
}

function list(value: string | undefined, lower: boolean): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => (lower ? s.trim().toLowerCase() : s.trim()))
    .filter((s) => s.length > 0);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 8080;
  if (!/^\d+$/.test(value))
    throw new ConfigError(`TRANSCODA_PORT must be an integer, got "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new ConfigError('TRANSCODA_PORT must be between 1 and 65535');
  return port;
}

/** `ffprobe` in the same directory as `ffmpegPath`, or bare `ffprobe` when it has none. */
function defaultFfprobe(ffmpegPath: string): string {
  const slash = ffmpegPath.lastIndexOf('/');
  return slash < 0 ? 'ffprobe' : `${ffmpegPath.slice(0, slash + 1)}ffprobe`;
}

function parseOutputRoots(value: string | undefined): string[] {
  const roots = list(value, false);
  if (roots.some((r) => !r.startsWith('/'))) {
    throw new ConfigError('TRANSCODA_OUTPUT_ROOTS entries must be absolute paths');
  }
  // Normalised once (resolved: no trailing slash, no `..`), so every comparison sees one spelling.
  return roots.map((r) => resolve(r));
}

function parsePublicUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const bad = () =>
    new ConfigError(
      'TRANSCODA_PUBLIC_URL must be an http(s) origin, for example https://transcoda.example.net',
    );
  if (!/^https?:\/\//.test(raw) || raw.includes('?') || raw.includes('#')) throw bad();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw bad();
  }
  return url.origin;
}

function parseId(name: 'PUID' | 'PGID', value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return Number(value.trim());
}

function parseNodeEnv(value: string | undefined): Config['nodeEnv'] {
  return value === 'production' || value === 'test' ? value : 'development';
}

function parseDevPlugins(value: string | undefined, nodeEnv: Config['nodeEnv']): string[] {
  const paths = list(value, false);
  if (paths.length === 0) return [];
  if (nodeEnv === 'production') {
    throw new ConfigError('TRANSCODA_DEV_PLUGINS is not allowed with NODE_ENV=production');
  }
  if (paths.some((p) => !p.startsWith('/'))) {
    throw new ConfigError('TRANSCODA_DEV_PLUGINS entries must be absolute paths');
  }
  return paths.map((p) => resolve(p));
}

function parsePluginInspect(value: string | undefined, nodeEnv: Config['nodeEnv']): boolean {
  if (value !== '1') return false;
  if (nodeEnv === 'production') {
    throw new ConfigError('TRANSCODA_PLUGIN_INSPECT is not allowed with NODE_ENV=production');
  }
  return true;
}

function parseCatalogKeys(
  value: string | undefined,
  nodeEnv: Config['nodeEnv'],
): SigningKey[] | null {
  const v = value?.trim();
  if (!v) return [...OFFICIAL_SIGNING_KEYS];
  if (v === 'none') {
    if (nodeEnv === 'production') {
      throw new ConfigError(
        'TRANSCODA_PLUGIN_CATALOG_KEY=none is not allowed with NODE_ENV=production',
      );
    }
    return null;
  }
  try {
    return parseSigningKeys(v);
  } catch (err) {
    throw new ConfigError(
      `TRANSCODA_PLUGIN_CATALOG_KEY: ${err instanceof Error ? err.message : 'invalid'}`,
    );
  }
}

function parseCatalogUrl(
  name: 'TRANSCODA_PLUGIN_CATALOG_URL' | 'TRANSCODA_PLUGIN_BLOCKLIST_URL',
  value: string | undefined,
  nodeEnv: Config['nodeEnv'],
  fallback: string,
): string {
  if (!value) return fallback;
  let scheme: string;
  try {
    scheme = new URL(value).protocol;
  } catch {
    throw new ConfigError(`${name} is not a url`);
  }
  const ok =
    scheme === 'https:' || (nodeEnv !== 'production' && (scheme === 'http:' || scheme === 'file:'));
  if (!ok) {
    throw new ConfigError(
      nodeEnv === 'production'
        ? `${name} must be an https url`
        : `${name} must be an https, http or file url`,
    );
  }
  return value;
}

function isolationId(name: 'UID' | 'GID', value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(
      `TRANSCODA_PLUGIN_${name} must be a non-negative integer, got "${value}"`,
    );
  }
  const n = Number(value.trim());
  // 0 would give a uid-0 host that regains capabilities; 4294967295 is setpriv's "unchanged" (the
  // host would run as the server). Both are refused, as is anything beyond a signed 32-bit id.
  if (!(n >= 1 && n <= 2147483647)) {
    throw new ConfigError(
      `TRANSCODA_PLUGIN_${name} must be between 1 and 2147483647, got "${value}"`,
    );
  }
  return n;
}

/**
 * Null when `TRANSCODA_PLUGIN_UID` is unset. A set uid that cannot be honoured is an error, never a
 * quiet fall back to running plugins as the server's own user.
 */
export function parseIsolation(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ownUid: number | null,
  ownGid: number | null = null,
): PluginIsolation | null {
  const rawUid = env.TRANSCODA_PLUGIN_UID;
  if (rawUid === undefined || rawUid.trim() === '') return null;
  const rawGid = env.TRANSCODA_PLUGIN_GID;
  if (rawGid === undefined || rawGid.trim() === '') {
    throw new ConfigError('TRANSCODA_PLUGIN_UID needs TRANSCODA_PLUGIN_GID');
  }
  if (platform !== 'linux')
    throw new ConfigError('TRANSCODA_PLUGIN_UID is only supported on Linux');
  const uid = isolationId('UID', rawUid);
  const gid = isolationId('GID', rawGid);
  if (ownUid !== null && uid === ownUid) {
    throw new ConfigError("TRANSCODA_PLUGIN_UID must differ from the server's uid");
  }
  if (ownGid !== null && gid === ownGid) {
    throw new ConfigError("TRANSCODA_PLUGIN_GID must differ from the server's group");
  }
  const runDir = env.TRANSCODA_PLUGIN_RUN_DIR || '/run/transcoda/plugins';
  if (!runDir.startsWith('/')) {
    throw new ConfigError('TRANSCODA_PLUGIN_RUN_DIR must be an absolute path');
  }
  // The server empties the run dir at start and stop: it must never be the config dir or inside it.
  const configDir = resolve(env.TRANSCODA_CONFIG_DIR || '/config');
  const rel = relative(configDir, resolve(runDir));
  if (rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))) {
    throw new ConfigError('TRANSCODA_PLUGIN_RUN_DIR must not be the config directory or inside it');
  }
  return { uid, gid, runDir, setprivPath: env.TRANSCODA_SETPRIV || '/usr/bin/setpriv' };
}

function parseUpdateCheck(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(`TRANSCODA_UPDATE_CHECK must be "true" or "false", got "${value}"`);
}

function parseIsolationSwitch(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'off') return true;
  throw new ConfigError(`TRANSCODA_PLUGIN_ISOLATION must be "off" or unset, got "${value}"`);
}

/** Production on Linux never starts quietly with plugins running as the server user. */
export function requireIsolationInProduction(config: Config, platform: NodeJS.Platform): void {
  if (
    config.nodeEnv === 'production' &&
    platform === 'linux' &&
    config.pluginIsolation === null &&
    !config.pluginIsolationOff
  ) {
    throw new ConfigError(
      'plugin isolation is off: mount a tmpfs at /run/transcoda (see docs/env.md) or set TRANSCODA_PLUGIN_ISOLATION=off to run plugins as the server user',
    );
  }
}

function parseBuildId(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v === '') return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) {
    throw new ConfigError(
      'TRANSCODA_BUILD_ID must be 1-64 letters, digits, dots, dashes or underscores',
    );
  }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.TRANSCODA_SECRET_KEY;
  if (secret !== undefined && secret !== '' && !/^[0-9a-fA-F]{64}$/.test(secret)) {
    // Never echo the value: it is a secret.
    throw new ConfigError('TRANSCODA_SECRET_KEY must be exactly 64 hex characters');
  }
  const ffmpegPath = env.TRANSCODA_FFMPEG_PATH || 'ffmpeg';
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const configDir = env.TRANSCODA_CONFIG_DIR || '/config';
  return {
    port: parsePort(env.TRANSCODA_PORT),
    host: env.TRANSCODA_HOST || '0.0.0.0',
    configDir,
    transcodeDir: env.TRANSCODA_TRANSCODE_DIR || '/transcode',
    allowedHosts: list(env.TRANSCODA_ALLOWED_HOSTS, true),
    publicUrl: parsePublicUrl(env.TRANSCODA_PUBLIC_URL),
    trustedProxies: list(env.TRANSCODA_TRUSTED_PROXIES, false),
    secretKeyHex: secret ? secret.toLowerCase() : null,
    buildId: parseBuildId(env.TRANSCODA_BUILD_ID),
    ffmpegPath,
    ffprobePath: env.TRANSCODA_FFPROBE_PATH || defaultFfprobe(ffmpegPath),
    outputRoots: parseOutputRoots(env.TRANSCODA_OUTPUT_ROOTS),
    puid: parseId('PUID', env.PUID),
    pgid: parseId('PGID', env.PGID),
    webDistDir: env.TRANSCODA_WEB_DIR || null,
    nodeEnv,
    pluginsDir: `${configDir}/plugins`,
    pluginHostPath:
      env.TRANSCODA_PLUGIN_HOST || fileURLToPath(new URL('./plugin-host.js', import.meta.url)),
    pluginCatalogUrl: parseCatalogUrl(
      'TRANSCODA_PLUGIN_CATALOG_URL',
      env.TRANSCODA_PLUGIN_CATALOG_URL,
      nodeEnv,
      OFFICIAL_CATALOG_URL,
    ),
    pluginCatalogKeys: parseCatalogKeys(env.TRANSCODA_PLUGIN_CATALOG_KEY, nodeEnv),
    pluginBlocklistUrl: parseCatalogUrl(
      'TRANSCODA_PLUGIN_BLOCKLIST_URL',
      env.TRANSCODA_PLUGIN_BLOCKLIST_URL,
      nodeEnv,
      OFFICIAL_BLOCKLIST_URL,
    ),
    catalogToken: env.TRANSCODA_CATALOG_TOKEN || null,
    devPlugins: parseDevPlugins(env.TRANSCODA_DEV_PLUGINS, nodeEnv),
    pluginInspect: parsePluginInspect(env.TRANSCODA_PLUGIN_INSPECT, nodeEnv),
    pluginIsolation: parseIsolation(
      env,
      process.platform,
      process.getuid?.() ?? null,
      process.getgid?.() ?? null,
    ),
    pluginIsolationOff: parseIsolationSwitch(env.TRANSCODA_PLUGIN_ISOLATION),
    updateCheck: parseUpdateCheck(env.TRANSCODA_UPDATE_CHECK),
    healthStallHours: parsePositive(
      'TRANSCODA_HEALTH_STALL_HOURS',
      'hours',
      env.TRANSCODA_HEALTH_STALL_HOURS,
      6,
    ),
    encodeStallMinutes: parseNonNegative(
      'TRANSCODA_ENCODE_STALL_MINUTES',
      'minutes',
      env.TRANSCODA_ENCODE_STALL_MINUTES,
      60,
    ),
    healthMinFreeGiB: parsePositive(
      'TRANSCODA_HEALTH_MIN_FREE_GIB',
      'GiB',
      env.TRANSCODA_HEALTH_MIN_FREE_GIB,
      5,
    ),
  };
}
