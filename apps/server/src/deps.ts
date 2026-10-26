import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import { LoginRateLimiter } from './auth/rate-limit.ts';
import { SessionService } from './auth/sessions.ts';
import { TokenService } from './auth/tokens.ts';
import { effectiveCapabilities, readEncodeDevice } from './capabilities/devices.ts';
import type { Exec } from './capabilities/ffmpeg.ts';
import { GpuLoadSampler } from './capabilities/gpu-load.ts';
import type { Config } from './config.ts';
import type { Database } from './db/open.ts';
import { listLibraries } from './db/repos/libraries.ts';
import { countUsers } from './db/repos/users.ts';
import { EngineService } from './engine/engine.ts';
import { type FsOps, nodeFsOps } from './engine/fs-ops.ts';
import { nodeSpawner, type ProcessSpawner } from './engine/process.ts';
import { usableInstallDir } from './fs/browse.ts';
import { HealthService } from './health.ts';
import { createAllowedHosts } from './http/host-check.ts';
import { parseTrustedProxies } from './http/request-info.ts';
import type { Logger } from './logger.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from './nodes/registry.ts';
import { PluginHooksRunner } from './plugins/hooks.ts';
import { loadLimits } from './plugins/limits.ts';
import { PluginRestartGate } from './plugins/restart-gate.ts';
import { PluginService, type PluginServiceDeps } from './plugins/service.ts';
import type { AppDeps } from './rpc/context.ts';
import { WorkflowService } from './workflows/service.ts';

export interface AppDepsInput {
  config: Config;
  db: Database;
  secretKey: Buffer;
  version: string;
  now?: () => Date;
  /** Result of the startup ffmpeg probe; until Task 20 wires it, defaults to "not probed". */
  capabilities?: Capabilities;
  /** The complete node list (core included); defaults to the core registry. */
  nodes?: RegisteredNode[];
  log: Logger;
  /** ffmpeg process runner (default: the real one). */
  spawner?: ProcessSpawner;
  /** Disk operations of the engine (default: node:fs). */
  fsOps?: FsOps;
  /** ffprobe/ffmpeg runner for probe, covers and verify (default: each module's own). */
  exec?: Exec;
  /** Settle window for "still growing" (default SETTLE_MINUTES). */
  settleMinutes?: number;
  /** Event-stream heartbeat (default HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** The server's time zone for run hours and job stats (default: the process's own). */
  timeZone?: string;
  /** Plugin job hooks runner (default: one with the stored hook timeout); the plugin service attaches its target. */
  hooks?: PluginHooksRunner;
  /** Library roots offered to path-mapping tests (default: the stored libraries). */
  libraryRoots?: () => string[];
  /** Plugin host identity reader for the isolation check (tests; default `/proc`). */
  identityOf?: PluginServiceDeps['identityOf'];
  /** Fetch-proxy resolver and address classifier (tests; default: the system resolver, real ranges). */
  fetchAddresses?: PluginServiceDeps['fetchAddresses'];
  /** Names of the TRANSCODA_* variables set at start (default: read from `process.env`, names only). */
  envSet?: ReadonlySet<string>;
  /** Generated third-party list (default: `third-party.json` in the install folder). */
  thirdPartyFile?: string;
}

/** The names (never the values) of the TRANSCODA_* variables in the environment. */
export function transcodaEnvNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(Object.keys(env).filter((k) => k.startsWith('TRANSCODA_')));
}

/** Wires the services around one db and one clock. Used by main.ts and the test app. */
export function createAppDeps(input: AppDepsInput): AppDeps {
  const now = input.now ?? (() => new Date());
  const { config, db } = input;
  const caps: Capabilities = input.capabilities ?? {
    available: false,
    path: 'ffmpeg',
    error: 'ffmpeg has not been probed',
  };
  // What Encode video and validation may use: the probe as the "Encoding device" setting allows.
  const encodingCaps = (): Capabilities => effectiveCapabilities(caps, readEncodeDevice(db));
  const registry = input.nodes ? new NodeRegistry(input.nodes) : createCoreRegistry();
  const workflows = new WorkflowService({
    db,
    registry,
    capabilities: encodingCaps,
    now,
    log: input.log,
    config,
  });
  const ownHooks = input.hooks === undefined;
  const hooks =
    input.hooks ??
    new PluginHooksRunner({ log: input.log, now, timeoutMs: loadLimits(db).hookTimeoutMs });
  const restartGate = new PluginRestartGate();
  const engine = new EngineService({
    db,
    config,
    workflows,
    registry,
    capabilities: encodingCaps,
    spawner: input.spawner ?? nodeSpawner,
    fs: input.fsOps ?? nodeFsOps,
    now,
    log: input.log,
    ...(input.exec ? { exec: input.exec } : {}),
    ...(input.settleMinutes !== undefined ? { settleMinutes: input.settleMinutes } : {}),
    ...(input.heartbeatMs !== undefined ? { heartbeatMs: input.heartbeatMs } : {}),
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
    hooks,
    restartGate,
  });
  const plugins = new PluginService({
    db,
    config,
    secretKey: input.secretKey,
    registry,
    workflows,
    events: engine.events,
    now,
    log: input.log,
    libraryRoots: input.libraryRoots ?? (() => listLibraries(db).map((l) => l.path)),
    ...(input.identityOf ? { identityOf: input.identityOf } : {}),
    ...(input.fetchAddresses ? { fetchAddresses: input.fetchAddresses } : {}),
  });
  restartGate.attachTarget(plugins.restartTarget());
  // A runner a test brought has its own target.
  if (ownHooks) hooks.attachTarget(plugins.hookTarget());
  return {
    config,
    db,
    version: input.version,
    allowedHosts: createAllowedHosts(db, config),
    trustedProxies: parseTrustedProxies(config.trustedProxies),
    secretKey: input.secretKey,
    // `src/` in development, `/app/server/` in the image (main.js is bundled there): one up is the install folder.
    installDir: usableInstallDir(resolve(dirname(fileURLToPath(import.meta.url)), '..'), input.log),
    // Same base as installDir: `apps/server/` under `pnpm dev`, `/app/` in the image (`pnpm licences` writes it).
    thirdPartyFile:
      input.thirdPartyFile ??
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'third-party.json'),
    sessions: new SessionService(db, now),
    tokens: new TokenService(db, now),
    limiter: new LoginRateLimiter({ now: () => now().getTime() }),
    setupRequired: () => countUsers(db) === 0,
    capabilities: () => caps,
    gpuLoad: new GpuLoadSampler({
      gpus: () => (caps.available ? (caps.gpus ?? []) : []),
      log: input.log,
    }),
    log: input.log,
    now,
    nodes: registry,
    workflows,
    engine,
    plugins,
    settings: {
      db,
      config,
      envSet: input.envSet ?? transcodaEnvNames(),
      version: input.version,
      plugins,
      capabilities: () => caps,
      now,
      log: input.log,
    },
    health: new HealthService({
      db,
      config,
      capabilities: () => caps,
      fs: input.fsOps ?? nodeFsOps,
      spaceWaits: () => engine.spaceWaits.list(),
      now,
      log: input.log,
    }),
  };
}
