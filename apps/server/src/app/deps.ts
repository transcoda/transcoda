import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import { createAllowedHosts } from '../auth/host-check.ts';
import { LoginRateLimiter } from '../auth/rate-limit.ts';
import { parseTrustedProxies } from '../auth/request-info.ts';
import { SessionService } from '../auth/sessions.ts';
import { TokenService } from '../auth/tokens.ts';
import { effectiveCapabilities, readEncodeDevice } from '../capabilities/devices.ts';
import type { Exec } from '../capabilities/ffmpeg.ts';
import { GpuLoadSampler } from '../capabilities/gpu-load.ts';
import { IntelLoadReader } from '../capabilities/intel-load.ts';
import type { Database } from '../db/open.ts';
import { findJob, findJobProbe } from '../db/repos/jobs.ts';
import { listLibraries } from '../db/repos/libraries.ts';
import { countUsers } from '../db/repos/users.ts';
import { nodeSpawner, type ProcessSpawner } from '../engine/encode/process.ts';
import { EngineService } from '../engine/engine.ts';
import { MetricsRecorder } from '../metrics/recorder.ts';
import { MetricsService } from '../metrics/service.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from '../nodes/registry.ts';
import type { Config } from '../platform/config.ts';
import { type FsOps, nodeFsOps } from '../platform/fs-ops.ts';
import type { Logger } from '../platform/logger.ts';
import { PluginHooksRunner } from '../plugins/runtime/hooks.ts';
import { loadLimits } from '../plugins/runtime/limits.ts';
import { PluginRestartGate } from '../plugins/runtime/restart-gate.ts';
import { PluginService, type PluginServiceDeps } from '../plugins/service.ts';
import type { AppDeps } from '../rpc/context.ts';
import { AppUpdateChecker } from '../system/app-update.ts';
import { usableInstallDir } from '../system/browse.ts';
import { HealthService } from '../system/health.ts';
import { WorkflowService } from '../workflows/service.ts';

export interface AppDepsInput {
  config: Config;
  db: Database;
  secretKey: Buffer;
  version: string;
  now?: () => Date;
  /** Result of the startup ffmpeg probe; "not probed" when not injected (tests). */
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
  /**
   * The install folder: `apps/server/` under `pnpm dev`, `/app/` in the image. main.ts passes it (one
   * up from main.ts, and from the bundled main.js); the default, two up from this file, is the same
   * folder when running from source (tests).
   */
  installDir?: string;
  /** Generated third-party list (default: `third-party.json` in the install folder). */
  thirdPartyFile?: string;
  /** The update check's fetch (tests; default the global one). */
  updateFetch?: typeof fetch;
}

/** The names (never the values) of the TRANSCODA_* variables in the environment. */
export function transcodaEnvNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(Object.keys(env).filter((k) => k.startsWith('TRANSCODA_')));
}

/** Wires the services around one db and one clock. Used by main.ts and the test app. */
export function createAppDeps(input: AppDepsInput): AppDeps {
  const now = input.now ?? (() => new Date());
  const installDir =
    input.installDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
  const fsOps = input.fsOps ?? nodeFsOps;
  const gpuLoad = new GpuLoadSampler({
    gpus: () => (caps.available ? (caps.gpus ?? []) : []),
    log: input.log,
    intel: new IntelLoadReader({ ffmpegPath: config.ffmpegPath }),
  });
  const recorder = new MetricsRecorder({
    now,
    jobTimes: (id) => {
      const job = findJob(db, id);
      if (!job) return null;
      const probe = findJobProbe(db, id);
      const media =
        probe && typeof probe === 'object' && !Array.isArray(probe)
          ? probe.durationSeconds
          : undefined;
      return {
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        ...(typeof media === 'number' ? { mediaSeconds: media } : {}),
      };
    },
    slots: () => engine.scheduler.status().encodeSlots,
  });
  engine.events.listen((e) => recorder.handle(e));
  const metrics = new MetricsService({
    db,
    version: input.version,
    now,
    queuePaused: () => engine.scheduler.status().paused,
    gpuLoad: () => gpuLoad.snapshot(),
    scratchFreeBytes: async () => {
      const { bavail, bsize } = await fsOps.statfs(config.transcodeDir);
      return bavail * bsize;
    },
    recorder,
  });
  return {
    config,
    db,
    version: input.version,
    allowedHosts: createAllowedHosts(db, config),
    trustedProxies: parseTrustedProxies(config.trustedProxies),
    secretKey: input.secretKey,
    installDir: usableInstallDir(installDir, input.log),
    // In the install folder: `pnpm notices` writes it there, the image copies it to `/app/`.
    thirdPartyFile: input.thirdPartyFile ?? resolve(installDir, 'third-party.json'),
    sessions: new SessionService(db, now),
    tokens: new TokenService(db, now),
    limiter: new LoginRateLimiter({ now: () => now().getTime() }),
    setupRequired: () => countUsers(db) === 0,
    capabilities: () => caps,
    gpuLoad,
    appUpdate: new AppUpdateChecker({
      version: input.version,
      enabled: config.updateCheck,
      events: engine.events,
      log: input.log,
      now,
      ...(input.updateFetch ? { fetch: input.updateFetch } : {}),
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
    metrics,
    health: new HealthService({
      db,
      config,
      capabilities: () => caps,
      fs: fsOps,
      spaceWaits: () => engine.spaceWaits.list(),
      now,
      log: input.log,
    }),
  };
}
