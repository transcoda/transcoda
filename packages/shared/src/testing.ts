// Helpers for tests only (`@transcoda/shared/testing`); nothing in the apps' runtime imports this.

/** fast-check's run count when `FC_NUM_RUNS` is unset or not a positive whole number. */
const DEFAULT_FC_RUNS = 100;

/**
 * Options for `fc.assert`: how many cases to try, from `FC_NUM_RUNS` (the nightly sets a large
 * number), else 100 so `pnpm test` stays fast. No seed: each run explores new cases, and a failure
 * prints the seed and path that reproduce it (docs/dev/testing.md, "Property tests").
 */
export function fcRuns(env: Record<string, string | undefined> = process.env): {
  numRuns: number;
} {
  const raw = env.FC_NUM_RUNS;
  const n = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  return { numRuns: Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_FC_RUNS };
}
