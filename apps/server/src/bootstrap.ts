import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateSecretKey } from './auth/secret-key.ts';
import { probeGpus } from './capabilities/devices.ts';
import { probeFfmpeg } from './capabilities/ffmpeg.ts';
import { type Config, requireIsolationInProduction } from './config.ts';
import { backupDirOf } from './db/backup.ts';
import { backupOnBuildChange, hashBuildFile } from './db/build-backup.ts';
import { migrate } from './db/migrate.ts';
import { migrations } from './db/migrations/index.ts';
import { openDatabase } from './db/open.ts';
import { createAppDeps } from './deps.ts';
import { setChildCapDrop } from './engine/child-caps.ts';
import { TEST_OUTPUT_SWEEP_MS } from './engine/test-outputs.ts';
import type { Logger } from './logger.ts';
import { assertIsolationUsable } from './plugins/isolation.ts';
import type { AppDeps } from './rpc/context.ts';
import { getDummyHash } from './rpc/procedures/auth.ts';
import { VERSION } from './version.ts';

const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Opens the database, runs migrations, probes ffmpeg, wires the services and upgrades workflows.
 * Throws SchemaTooNewError (main.ts maps it to exit code 3); never calls process.exit.
 */
export async function createDeps(
  config: Config,
  log: Logger,
): Promise<AppDeps & { close(): void }> {
  // Outside the degraded-mode try/catch around `plugins.start()` below: configured isolation that
  // cannot work stops the server (exit code as for a ConfigError); it never runs plugins same-uid.
  if (config.pluginIsolation !== null) {
    await assertIsolationUsable(config.pluginIsolation);
    // ffmpeg and ffprobe must not inherit the server's ambient capabilities either.
    setChildCapDrop(config.pluginIsolation.setprivPath);
  } else {
    // Production on Linux must have isolation or say explicitly (=off) that it does not want it.
    requireIsolationInProduction(config, process.platform);
    if (config.nodeEnv === 'production') {
      log.warn("plugin hosts run as the server's user (TRANSCODA_PLUGIN_UID is not set)");
    }
  }
  mkdirSync(config.configDir, { recursive: true });
  const secretKey = loadOrCreateSecretKey(config.configDir, config.secretKeyHex, (m) =>
    log.warn(m),
  );
  const db = openDatabase(join(config.configDir, 'transcoda.sqlite'));
  const backupDir = backupDirOf(config.configDir);
  try {
    const migrated = migrate(db, migrations, { backupDir, log: (m) => log.info(m) });
    // Before anything else writes (plugins, workflow upgrades, the engine's sweep): a new build
    // gets a backup even without a migration. In the image `import.meta.url` is the bundled
    // /app/server/main.js, so the hash covers all server code. Under `pnpm dev` (tsx) it is this
    // source file, bootstrap.ts, alone: edits elsewhere keep the id, so dev starts rarely back up
    // (set TRANSCODA_BUILD_ID to force one).
    const buildId = config.buildId ?? hashBuildFile(fileURLToPath(import.meta.url));
    if (buildId === null) {
      log.warn('could not read the server bundle to identify the build; no build-change backup');
    } else {
      backupOnBuildChange(db, {
        backupDir,
        buildId,
        existedBefore: migrated.from > 0,
        migrationBackup: migrated.backupFile !== null,
        log: (m) => log.info(m),
      });
    }
  } catch (err) {
    db.close();
    throw err;
  }

  // CUDA numbers GPUs fastest-first by default; ffmpeg (a child) must count as nvidia-smi does.
  process.env.CUDA_DEVICE_ORDER ??= 'PCI_BUS_ID';
  const probed = await probeFfmpeg(config.ffmpegPath);
  const capabilities = probed.available ? { ...probed, gpus: await probeGpus() } : probed;
  if (!capabilities.available) {
    log.warn(
      `ffmpeg unavailable (${capabilities.error ?? 'unknown error'}); transcoding is disabled`,
    );
  }

  // Warm the login timing-equaliser hash; a failure is retried on first login.
  getDummyHash().catch(() => log.warn('could not precompute the login dummy hash; will retry'));

  if (config.nodeEnv === 'production' && config.pluginCatalogKeys?.length === 0) {
    log.warn('official plugin catalog is refused: no signing key is pinned in this build');
  }

  const deps = createAppDeps({ config, db, secretKey, version: VERSION, capabilities, log });
  // Plugin nodes must be registered before workflows are validated or upgraded. A plugin that
  // fails shows its reason on the Plugins page. If start() itself throws (an unusable plugins
  // directory) the server runs degraded: no plugin nodes are registered, so workflows using one
  // show UNKNOWN_NODE_TYPE (never run), the error is logged, and everything else works.
  try {
    await deps.plugins.start();
  } catch (err) {
    log.error(`plugins did not start: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  // Bring stored workflows up to the registered node versions; logs its own summary.
  deps.workflows.upgradeAll();
  // Startup sweep, recycle prune and the scheduler; jobs only run once workflows are upgraded.
  // A failing start (say an unreadable transcode dir) leaves the engine stopped: the server still
  // starts so the problem can be seen (`engine.startError`, the log) and fixed.
  try {
    await deps.engine.start();
  } catch (err) {
    log.error(
      `engine did not start: ${err instanceof Error ? err.message : 'unknown error'}; no jobs will run`,
    );
  }
  // NVENC/NVDEC load for the Jobs page; does nothing without NVIDIA GPUs.
  deps.gpuLoad.start();
  // Asks GitHub for a newer release a minute after start, then every 6 h (off with TRANSCODA_UPDATE_CHECK=false).
  deps.appUpdate.start();
  const timer = setInterval(() => {
    try {
      deps.sessions.purgeExpired();
      deps.limiter.prune();
    } catch (err) {
      log.warn(`maintenance failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    // Logs its own failures; never rejects.
    void deps.engine.pruneRecycle();
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  // Expired and stray test-encode outputs; logs its own failures and never rejects.
  const testOutputTimer = setInterval(
    () => void deps.engine.sweepTestOutputs(),
    TEST_OUTPUT_SWEEP_MS,
  );
  testOutputTimer.unref();

  return {
    ...deps,
    close() {
      deps.gpuLoad.stop();
      deps.appUpdate.stop();
      clearInterval(timer);
      clearInterval(testOutputTimer);
      if (db.open) db.close();
    },
  };
}
