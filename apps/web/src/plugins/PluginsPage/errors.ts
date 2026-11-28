import { ORPCError } from '@orpc/client';
import { describeError } from '../../api/errors.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The reason of a plugin failure (`PLUGIN_INSTALL_FAILED`, `PLUGIN_NOT_RUNNING` carry one); any
 * other failure in the usual words.
 */
export function pluginFailure(err: unknown): string {
  if (
    err instanceof ORPCError &&
    (err.code === 'PLUGIN_INSTALL_FAILED' || err.code === 'PLUGIN_NOT_RUNNING') &&
    isRecord(err.data) &&
    typeof err.data.reason === 'string'
  ) {
    return err.data.reason;
  }
  return describeError(err).message;
}

/**
 * The messages of `PLUGIN_SETTINGS_INVALID` by top-level setting key (the form's fields), the
 * first one for each; `''` for one without a path. Null for another failure. A nested path
 * (`tags.1`, `server.port`) belongs to the field of its first segment.
 */
export function settingsIssuesOf(err: unknown): Record<string, string> | null {
  if (!(err instanceof ORPCError) || err.code !== 'PLUGIN_SETTINGS_INVALID') return null;
  if (!isRecord(err.data) || !Array.isArray(err.data.issues)) return null;
  const out: Record<string, string> = {};
  for (const issue of err.data.issues) {
    if (isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string') {
      const key = issue.path.split('.')[0] ?? '';
      out[key] ??= issue.message;
    }
  }
  return out;
}

export function isNotRunning(err: unknown): boolean {
  return err instanceof ORPCError && err.code === 'PLUGIN_NOT_RUNNING';
}
