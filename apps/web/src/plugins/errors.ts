import { ORPCError } from '@orpc/client';
import { describeError } from '../api/errors.ts';

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

/** The per-field messages of `PLUGIN_SETTINGS_INVALID` by setting path, or null for another failure. */
export function settingsIssuesOf(err: unknown): Record<string, string> | null {
  if (!(err instanceof ORPCError) || err.code !== 'PLUGIN_SETTINGS_INVALID') return null;
  if (!isRecord(err.data) || !Array.isArray(err.data.issues)) return null;
  const out: Record<string, string> = {};
  for (const issue of err.data.issues) {
    if (isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string') {
      out[issue.path] = issue.message;
    }
  }
  return out;
}

export function isNotRunning(err: unknown): boolean {
  return err instanceof ORPCError && err.code === 'PLUGIN_NOT_RUNNING';
}
