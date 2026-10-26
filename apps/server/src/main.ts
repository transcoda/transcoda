import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createDeps } from './bootstrap.ts';
import { ConfigError, loadConfig } from './config.ts';
import { exitCodeFor } from './exit-code.ts';
import { createLogger } from './logger.ts';
import { runCheckPlugin } from './plugins/check-plugin.ts';
import { IsolationError } from './plugins/isolation.ts';
import { installProcessGuards } from './process-guards.ts';
import { VERSION } from './version.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let startupNodeEnv = process.env.NODE_ENV ?? 'development';
/** Closes the database once the server is up; the fatal path runs it before exiting. */
let closeDeps: (() => void) | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  startupNodeEnv = config.nodeEnv;
  const log = createLogger(config.nodeEnv);
  const deps = await createDeps(config, log);
  closeDeps = () => deps.close();
  const app = createApp({ deps, log });
  const ffmpeg = deps.capabilities();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    log.info(
      `transcoda ${VERSION} listening on http://${config.host}:${config.port} (ffmpeg: ${ffmpeg.available ? ffmpeg.version : 'unavailable'})`,
    );
  });

  server.on('error', (err: Error) => {
    log.error(`failed to listen on ${config.host}:${config.port}: ${err.message}`);
    deps.close();
    process.exit(1);
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      log.error(`received ${signal} during shutdown, forcing exit`);
      process.exit(1);
    }
    stopping = true;
    log.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    // Jobs first: ffmpeg groups are killed and nothing is written (the next start sweeps them).
    deps.engine
      .stop()
      .catch((err: unknown) => {
        log.error(`engine stop failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      })
      .then(() => deps.plugins.stop())
      .catch((err: unknown) => {
        log.error(`plugins stop failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      })
      .finally(() => {
        server.close(() => {
          deps.close();
          process.exit(0);
        });
        // Idle keep-alive connections would otherwise hold close() open.
        if ('closeIdleConnections' in server) server.closeIdleConnections();
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// `--check-plugin` is a one-shot: no config, no database, no ffmpeg probe, no secret key.
if (process.argv.includes('--check-plugin')) {
  runCheckPlugin(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
} else {
  runServer();
}

function runServer(): void {
  installProcessGuards(process, {
    log: createLogger(startupNodeEnv),
    fatal: (code) => {
      try {
        closeDeps?.();
      } finally {
        process.exit(code);
      }
    },
  });
  main().catch(failStart);
}

function failStart(err: unknown): void {
  const log = createLogger(startupNodeEnv);
  const code = exitCodeFor(err);
  const message = err instanceof Error ? err.message : 'unknown error';
  if (code === 3) log.error(message);
  else if (err instanceof ConfigError || err instanceof IsolationError)
    log.error(`configuration error: ${message}`);
  else log.error(`failed to start: ${message}`);
  process.exit(code);
}
