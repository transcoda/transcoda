import type { Logger } from './logger.ts';

interface Target {
  on(event: 'uncaughtException', fn: (err: unknown, origin: string) => void): unknown;
  on(event: 'unhandledRejection', fn: (reason: unknown) => void): unknown;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The server's last line of defence. A stray rejected promise is logged and the server keeps
 * running (nothing was left half-done by a throw). An uncaught exception is fatal: the state it
 * left is unknown, so it is logged and the process exits through `fatal` (which closes what it
 * can). Plugin channels cannot reach here any more: their frames are parsed in channel.ts.
 */
export function installProcessGuards(
  target: Target,
  deps: { log: Logger; fatal(code: number): void },
): void {
  let dying = false;
  target.on('unhandledRejection', (reason) => {
    deps.log.error({ msg: 'unhandled promise rejection', error: messageOf(reason) });
  });
  target.on('uncaughtException', (err, origin) => {
    if (dying) return;
    dying = true;
    deps.log.error({
      msg: 'uncaught exception, exiting',
      error: messageOf(err),
      origin,
      stack: err instanceof Error ? err.stack : undefined,
    });
    deps.fatal(1);
  });
}
