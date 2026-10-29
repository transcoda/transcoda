import type { BlockList } from 'node:net';
import type { Capabilities, User } from '@transcoda/contract';
import type { TokenScope } from '@transcoda/shared';
import type { Database } from 'better-sqlite3';
import type { LoginRateLimiter } from '../auth/rate-limit.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { TokenService } from '../auth/tokens.ts';
import type { GpuLoadSampler } from '../capabilities/gpu-load.ts';
import type { Config } from '../config.ts';
import type { EngineService } from '../engine/engine.ts';
import type { HealthService } from '../health.ts';
import type { Logger } from '../logger.ts';
import type { NodeRegistry } from '../nodes/registry.ts';
import type { PluginService } from '../plugins/service.ts';
import type { SettingsDeps } from '../settings/service.ts';
import type { AppUpdateChecker } from '../updates/app-update.ts';
import type { WorkflowService } from '../workflows/service.ts';

export type AuthContext =
  | { kind: 'none' }
  | { kind: 'session'; user: User; sessionIdHash: string }
  | { kind: 'token'; user: User; tokenId: string; scopes: TokenScope[] };

// Single definition; later tasks add fields (capabilities). Built by `createAppDeps` (src/deps.ts).
export interface AppDeps {
  config: Config;
  db: Database;
  version: string;
  allowedHosts: () => string[];
  trustedProxies: BlockList;
  secretKey: Buffer;
  /** The app's own install folder (hidden from the folder picker); null when it resolved to `/`. */
  installDir: string | null;
  /** Path of the generated `third-party.json` (may not exist in a dev checkout). */
  thirdPartyFile: string;
  sessions: SessionService;
  tokens: TokenService;
  limiter: LoginRateLimiter;
  setupRequired: () => boolean;
  /** Cached ffmpeg probe result (probed once at startup). */
  capabilities: () => Capabilities;
  /** NVENC/NVDEC load over the last hour; started by bootstrap, stopped at close. */
  gpuLoad: GpuLoadSampler;
  /** Whether a newer release exists; started by bootstrap, stopped at close. */
  appUpdate: AppUpdateChecker;
  /** The app's logger (handlers never pass secrets to it). */
  log: Logger;
  /** Clock shared by the services (injectable for tests). */
  now: () => Date;
  /** Node definitions (core, plus plugins later). */
  nodes: NodeRegistry;
  workflows: WorkflowService;
  /** Queueing, scheduler, pipeline and events; started by bootstrap (tests start it themselves). */
  engine: EngineService;
  /** Installed plugins: started by bootstrap (tests start it themselves), stopped at shutdown. */
  plugins: PluginService;
  /** Deep health check for monitors (`GET /system/health?deep=1`), cached for 10 s. */
  health: HealthService;
  /** What the settings service reads and writes through (`settings.get` / `settings.update`). */
  settings: SettingsDeps;
}

export interface ServerContext {
  req: Request;
  // Injected by ResponseHeadersPlugin (compatible with ResponseHeadersPluginContext).
  resHeaders?: Headers;
  remoteAddr: string;
  auth: AuthContext;
  deps: AppDeps;
}
