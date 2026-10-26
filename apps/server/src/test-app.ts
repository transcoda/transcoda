import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import type { Hono } from 'hono';
import { createApp } from './app.ts';
import type { Exec } from './capabilities/ffmpeg.ts';
import { type Config, loadConfig } from './config.ts';
import type { Database } from './db/open.ts';
import { createTestDb } from './db/test-db.ts';
import { createAppDeps } from './deps.ts';
import type { FsOps } from './engine/fs-ops.ts';
import type { ProcessSpawner } from './engine/process.ts';
import { createLogger, type Logger } from './logger.ts';
import type { AnyToolDef } from './mcp/tool.ts';
import type { RegisteredNode } from './nodes/registry.ts';
import type { PluginHooksRunner } from './plugins/hooks.ts';
import type { PluginServiceDeps } from './plugins/service.ts';
import { hostPath } from './plugins/testing/build.ts';
import type { AppDeps } from './rpc/context.ts';

/** The host the vitest globalSetup built; absent outside a test run that built it (never needed until a plugin starts). */
function defaultHostPath(): string {
  try {
    return hostPath();
  } catch {
    return loadConfig({}).pluginHostPath;
  }
}

/**
 * Tests never reach GitHub for the blocklist: the default is one shared local file holding an empty
 * valid list (the same bytes every time, so parallel workers may write it; one file, no cleanup).
 */
function emptyBlocklistUrl(): string {
  const file = join(tmpdir(), 'transcoda-test-empty-blocklist.json');
  const body = JSON.stringify({ schema: 1, generated: '2026-01-01T00:00:00.000Z', entries: [] });
  try {
    if (readFileSync(file, 'utf8') === body) return pathToFileURL(file).href;
  } catch {
    // missing or unreadable: write it below
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  return pathToFileURL(file).href;
}

export const TEST_SECRET_KEY = Buffer.alloc(32, 7);

export interface TestClock {
  now: () => Date;
  advance: (ms: number) => void;
}

export interface TestAppOptions {
  config?: Partial<Config>;
  remoteAddr?: string;
  start?: Date;
  capabilities?: Capabilities;
  /** Complete node list (core included); defaults to the core registry. */
  nodes?: RegisteredNode[];
  /** Reuse a database (e.g. a second app over the same data, as after a restart). */
  db?: Database;
  log?: Logger;
  /** Engine process runner (default: the real one). */
  spawner?: ProcessSpawner;
  fsOps?: FsOps;
  exec?: Exec;
  /** "Still growing" window; default 0 (off) in tests. */
  settleMinutes?: number;
  /** Event-stream heartbeat (default 30 s). */
  heartbeatMs?: number;
  /** The server's time zone (default: the test process's own). */
  timeZone?: string;
  /** Plugin job hooks runner. */
  hooks?: PluginHooksRunner;
  /** Tools offered on /mcp (default: all of them). */
  mcpTools?: AnyToolDef[];
  /** Plugins: the built host (default: the one the test run built) and dev bundles to load. */
  plugins?: {
    hostPath?: string;
    devPlugins?: string[];
    identityOf?: PluginServiceDeps['identityOf'];
    fetchAddresses?: PluginServiceDeps['fetchAddresses'];
  };
  /** Library roots for path-mapping tests (default: the stored libraries). */
  libraryRoots?: () => string[];
  /** Generated third-party list served by `system.licences` (default: the install folder's). */
  thirdPartyFile?: string;
}

export interface TestApp {
  app: Hono;
  deps: AppDeps;
  db: Database;
  clock: TestClock;
  setRemoteAddr: (addr: string) => void;
  /** Stops the plugins and removes the plugins directory this app made. */
  close(): Promise<void>;
}

/**
 * App over a real migrated `:memory:` db, a fixed secret key, a manual clock and a configurable
 * peer address. The engine is never started here: tests call `deps.engine.start()` / `stop()`.
 */
export function createTestApp(opts: TestAppOptions = {}): TestApp {
  // `loadConfig({})` would point the plugins at /config/plugins: every test app gets its own (not yet created: `start()` makes it).
  const pluginsDir = join(tmpdir(), `transcoda-plugins-${randomUUID()}`);
  const config: Config = {
    ...loadConfig({}),
    nodeEnv: 'test',
    pluginBlocklistUrl: emptyBlocklistUrl(),
    // Tests never reach GitHub: the official catalog is unsigned here unless a test sets keys.
    pluginCatalogKeys: null,
    pluginsDir,
    pluginHostPath: opts.plugins?.hostPath ?? defaultHostPath(),
    devPlugins: opts.plugins?.devPlugins ?? [],
    ...opts.config,
  };
  const db = opts.db ?? createTestDb();
  const log = opts.log ?? createLogger('test');
  let t = (opts.start ?? new Date('2026-01-01T00:00:00.000Z')).getTime();
  const clock: TestClock = {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
  let remoteAddr = opts.remoteAddr ?? '127.0.0.1';
  const deps = createAppDeps({
    config,
    db,
    secretKey: TEST_SECRET_KEY,
    version: '9.9.9',
    now: clock.now,
    log,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.nodes ? { nodes: opts.nodes } : {}),
    ...(opts.spawner ? { spawner: opts.spawner } : {}),
    ...(opts.fsOps ? { fsOps: opts.fsOps } : {}),
    ...(opts.exec ? { exec: opts.exec } : {}),
    settleMinutes: opts.settleMinutes ?? 0,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.libraryRoots ? { libraryRoots: opts.libraryRoots } : {}),
    ...(opts.plugins?.identityOf ? { identityOf: opts.plugins.identityOf } : {}),
    ...(opts.plugins?.fetchAddresses ? { fetchAddresses: opts.plugins.fetchAddresses } : {}),
    ...(opts.thirdPartyFile !== undefined ? { thirdPartyFile: opts.thirdPartyFile } : {}),
  });
  const app = createApp({
    deps,
    log,
    getRemoteAddr: () => remoteAddr,
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
  });
  return {
    app,
    deps,
    db,
    clock,
    setRemoteAddr: (addr) => {
      remoteAddr = addr;
    },
    async close() {
      await deps.plugins.stop();
      // Only the directory this app chose itself.
      if (config.pluginsDir === pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
    },
  };
}
