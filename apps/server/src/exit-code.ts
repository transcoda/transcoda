import { ConfigError } from './config.ts';
import { SchemaTooNewError } from './db/migrate.ts';
import { IsolationError } from './plugins/isolation.ts';

/** Process exit code for a startup failure: 2 bad config (plugin isolation that cannot work counts), 3 database newer than this server, 1 anything else. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof ConfigError || err instanceof IsolationError) return 2;
  if (err instanceof SchemaTooNewError) return 3;
  return 1;
}
