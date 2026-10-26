import { DEFAULT_LIMITS, type PluginLimits, type SupervisorLimits } from '@transcoda/shared';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { getSetting } from '../db/repos/settings.ts';

const HOUR_MS = 3_600_000;

/** Upper bounds per key; a stored value above its bound falls back to the default. */
export const LIMIT_BOUNDS: Readonly<SupervisorLimits> = {
  callTimeoutMs: HOUR_MS,
  finishRunTimeoutMs: HOUR_MS,
  testTimeoutMs: HOUR_MS,
  triggerTimeoutMs: HOUR_MS,
  hookTimeoutMs: HOUR_MS,
  startTimeoutMs: HOUR_MS,
  heapMb: 4096,
  // A host past 2 GB RSS is a runaway, not a plugin that needs room (see docs/decisions.md 2026-10-21).
  rssMb: 2048,
  backoffMinMs: HOUR_MS,
  backoffMaxMs: HOUR_MS,
  stableMs: HOUR_MS,
  maxCrashes: 100,
  crashWindowMs: HOUR_MS,
  fetchDefaultTimeoutMs: HOUR_MS,
  fetchMaxTimeoutMs: HOUR_MS,
  fetchConcurrency: 16,
  fetchPerSecond: 1000,
  fetchBodyBytes: 268_435_456,
  cacheEntries: 1_000_000,
  cacheBytes: 1_073_741_824,
  maxHosts: 256,
  cancelGraceMs: 60_000,
};

/** Defaults overridden by `plugins.limits.<key>` settings rows; a malformed row is ignored. */
export function loadLimits(db: Database): SupervisorLimits {
  const out: SupervisorLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof SupervisorLimits)[]) {
    try {
      const v = getSetting(
        db,
        `plugins.limits.${key}`,
        z.number().int().positive().max(LIMIT_BOUNDS[key]),
      );
      if (v !== null) out[key] = v;
    } catch {
      // not a positive integer (or not JSON): keep the default
    }
  }
  return out;
}

/** The subset sent to the host in `init`. */
export function hostLimits(l: SupervisorLimits): PluginLimits {
  return {
    callTimeoutMs: l.callTimeoutMs,
    finishRunTimeoutMs: l.finishRunTimeoutMs,
    testTimeoutMs: l.testTimeoutMs,
    triggerTimeoutMs: l.triggerTimeoutMs,
    hookTimeoutMs: l.hookTimeoutMs,
    fetchDefaultTimeoutMs: l.fetchDefaultTimeoutMs,
    fetchMaxTimeoutMs: l.fetchMaxTimeoutMs,
    cacheEntries: l.cacheEntries,
    cacheBytes: l.cacheBytes,
  };
}
