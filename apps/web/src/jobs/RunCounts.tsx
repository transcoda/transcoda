import type { RunDetail } from '@transcoda/contract';
import { type JobState, RUN_OUTCOME_KEYS } from '@transcoda/shared';
import { Icon, type IconName } from '../components/Icon.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { fmtBytes } from '../lib/bytes.ts';
import { DryRunBadge, PausedChip, VERDICT_ICON } from './JobStateChip.tsx';
import type { Verdict } from './jobText.ts';

export type OutcomeKey = (typeof RUN_OUTCOME_KEYS)[number];

// Colour never carries meaning alone: every outcome has an icon and a word. Icons follow screen 07
// where it draws one (replaced check, kept original back-arrow, failed cross, skipped chevron) and
// reuse the existing set for the rest.
export const OUTCOME_LABEL: Record<OutcomeKey, { word: string; icon: IconName }> = {
  done: { word: 'Replaced', icon: 'check' },
  nothing_to_do: { word: 'Nothing to do', icon: 'state-noop' },
  kept_original: { word: 'Kept original', icon: 'undo' },
  failed: { word: 'Failed', icon: 'cross' },
  cancelled: { word: 'Canceled', icon: 'x-circle' },
  // Never drawn as its own tile or word of a real run: a dry run is counted as the outcome it
  // would have had (see `outcomeWord`), and the "Dry run" badge marks the run.
  dry_run: { word: 'Would replace', icon: 'check' },
  skipped: { word: 'Skipped', icon: 'chevron-right' },
  already_processed: { word: 'Already processed', icon: 'check-circle' },
  queued: { word: 'Queued', icon: 'clock' },
  in_progress: { word: 'In progress', icon: 'play' },
};

/**
 * The design's tile order (run summary): replaced, kept original, nothing to do, failed, … No
 * "Dry run" tile: the dry-run count is folded into the replaced tile (see `RunCounts`).
 */
export const OUTCOME_ORDER: readonly OutcomeKey[] = [
  'done',
  'kept_original',
  'nothing_to_do',
  'failed',
  'cancelled',
  'skipped',
  'already_processed',
  'queued',
  'in_progress',
];

/**
 * A job's state as a run outcome: a queued job is "queued" (it may wait on a paused queue), the
 * other active states (probing … replacing) are "in progress".
 */
export function outcomeOf(state: JobState): OutcomeKey {
  return (RUN_OUTCOME_KEYS as readonly string[]).includes(state)
    ? (state as OutcomeKey)
    : 'in_progress';
}

/** What a dry run's outcome is called: "would" for the two that change something. */
const WOULD_LABEL: Partial<Record<OutcomeKey, string>> = {
  done: 'Would replace',
  dry_run: 'Would replace',
  kept_original: 'Would keep original',
};

/** The outcome's word: as a "would" in a dry run, otherwise as it is. */
export function outcomeWord(outcome: OutcomeKey, dryRun: boolean): string {
  return (dryRun && WOULD_LABEL[outcome]) || OUTCOME_LABEL[outcome].word;
}

/** The Jobs list chip's verdict for a run outcome, so both pages draw the same chip. */
const OUTCOME_VERDICT: Record<OutcomeKey, Verdict> = {
  done: 'replaced',
  dry_run: 'replaced',
  kept_original: 'kept',
  nothing_to_do: 'noop',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  already_processed: 'already',
  queued: 'queued',
  in_progress: 'running',
};

/** A run file's verdict: a dry run's "would" outcomes are the dry-run amber. */
export function outcomeVerdict(outcome: OutcomeKey, dryRun = false): Verdict {
  return dryRun && WOULD_LABEL[outcome] ? 'dry' : OUTCOME_VERDICT[outcome];
}

/**
 * A run file's outcome as the Jobs list chip (same size, colours and icons). A dry run's file shows
 * what would have happened, with the dashed "Dry run" badge beside it.
 */
export function OutcomeChip({
  outcome,
  dryRun = false,
  estimate = null,
  word = null,
  testEncode = false,
  paused = false,
  badge = dryRun,
}: {
  outcome: OutcomeKey;
  dryRun?: boolean;
  /** A dry run's estimated size change ("−34%"), appended to the word. */
  estimate?: string | null;
  /** Replaces the outcome's word ("Would replace if it saves ≥ 25%" when the size gate decides). */
  word?: string | null;
  /** The run test-encoded: the badge says "Test encode". */
  testEncode?: boolean;
  /** The job itself is paused: the Jobs list's second "Paused" chip. */
  paused?: boolean;
  /**
   * The dashed "Dry run" / "Test encode" badge beside the chip (default: in a dry run). The run
   * page leaves it out: its heading carries the badge once for every file.
   */
  badge?: boolean;
}) {
  const verdict = outcomeVerdict(outcome, dryRun);
  const text = word ?? outcomeWord(outcome, dryRun);
  return (
    <span className="job-chips">
      <span className={`job-chip is-${verdict}`}>
        <Icon name={VERDICT_ICON[OUTCOME_VERDICT[outcome]]} size={13} strokeWidth={2.6} />
        {estimate ? `${text} · ${estimate}` : text}
      </span>
      {badge ? <DryRunBadge testEncode={testEncode} /> : null}
      {paused ? <PausedChip /> : null}
    </span>
  );
}

const num = new Intl.NumberFormat('en-US');

/** The rest of a plan-only dry run's outcomes, in the summary's words; each only when it happened. */
const SUMMARY_REST: ReadonlyArray<[OutcomeKey, string]> = [
  ['kept_original', 'would keep original'],
  ['skipped', 'skipped'],
  ['failed', 'failed'],
  ['cancelled', 'canceled'],
  ['already_processed', 'already processed'],
  ['queued', 'queued'],
  ['in_progress', 'in progress'],
];

/**
 * What a dry run's files would do, counted apart: "3 would replace · 2 depend on size · 1 nothing to
 * do" (#41), then every other outcome that happened ("· 1 skipped · 1 failed"), so the line adds up
 * to every file. A file whose size gate decides after encoding is not counted as "would replace".
 */
export function dryRunSummary(counts: RunDetail['counts']): string {
  const depends = counts.dependsOnSize ?? 0;
  const would = counts.done + counts.dry_run - depends;
  const rest = SUMMARY_REST.filter(([k]) => counts[k] > 0).map(
    ([k, word]) => `${num.format(counts[k])} ${word}`,
  );
  return [
    `${would} would replace`,
    `${depends} ${depends === 1 ? 'depends' : 'depend'} on size`,
    `${counts.nothing_to_do} nothing to do`,
    ...rest,
  ].join(' · ');
}

/**
 * The tiles a run always shows, even at 0, so the row neither shifts nor wraps differently while
 * the run goes on. A plan-only dry run shows "Depends on size" and keeps an original only rarely
 * (its tile then shows as any other outcome that happened).
 * The rare outcomes (cancelled, already processed) get a tile only when they happened; queued and
 * in progress only while some file still waits or runs.
 */
const FIXED_TILES: readonly OutcomeKey[] = [
  'done',
  'kept_original',
  'nothing_to_do',
  'failed',
  'skipped',
];

/**
 * The run's tiles, in the Jobs tile style: first what it saved ("554 GB", "1.19 TB → 636 GB") in a
 * real run, then the fixed outcome tiles (dimmed at 0; 0 failed is good news and stays bright) and
 * any other outcome that happened. The keys must sum to `total`; only when they do not does a line
 * say how many files are unaccounted for.
 */
export function RunCounts({
  counts,
  dryRun = false,
  planOnly = false,
}: {
  counts: RunDetail['counts'];
  dryRun?: boolean;
  /**
   * A plan-only dry run: its files whose size gate decides after encoding get their own tile and
   * the "would replace · depend on size · nothing to do" line (a test-encode measures them).
   */
  planOnly?: boolean;
}) {
  const accounted = RUN_OUTCOME_KEYS.reduce((sum, k) => sum + counts[k], 0);
  const depends = counts.dependsOnSize ?? 0;
  const tiles: Array<{ key: string; label: string; value: string; sub?: string; zero: boolean }> =
    [];
  if (!dryRun) {
    const change = counts.beforeBytes - counts.afterBytes;
    tiles.push({
      key: 'saved',
      label: change >= 0 ? 'Saved' : 'Grew',
      value: fmtBytes(Math.abs(change)),
      ...(counts.done > 0
        ? { sub: `${fmtBytes(counts.beforeBytes)} → ${fmtBytes(counts.afterBytes)}` }
        : {}),
      zero: counts.done === 0,
    });
  }
  const active = counts.queued + counts.in_progress > 0;
  for (const k of OUTCOME_ORDER) {
    // A dry-run job ends `dry_run`: it is the outcome "replaced" would have had, unless its size
    // gate decides after encoding (its own tile, #41).
    const n = k === 'done' ? counts.done + counts.dry_run - depends : counts[k];
    const fixed = FIXED_TILES.includes(k) && !(planOnly && k === 'kept_original');
    const waiting = active && (k === 'queued' || k === 'in_progress');
    if (n > 0 || fixed || waiting) {
      tiles.push({
        key: k,
        label: outcomeWord(k, dryRun),
        value: num.format(n),
        zero: n === 0 && k !== 'failed',
      });
    }
    if (k === 'done' && planOnly) {
      tiles.push({
        key: 'depends',
        label: 'Depends on size',
        value: num.format(depends),
        zero: depends === 0,
      });
    }
  }
  const missing = counts.total - accounted;
  return (
    <section className="run-counts" aria-label="Counts">
      {tiles.length > 0 ? (
        <ul className="stat-tiles run-stats" aria-label="Outcomes">
          {tiles.map((t) => (
            <StatTile key={t.key} label={t.label} value={t.value} sub={t.sub} zero={t.zero} />
          ))}
        </ul>
      ) : null}
      {planOnly ? <p className="run-dry-summary">{dryRunSummary(counts)}</p> : null}
      {missing !== 0 ? (
        <p className="run-mismatch" role="alert">
          <Icon name="alert" size={16} round />
          {missing > 0
            ? `${num.format(missing)} of ${num.format(counts.total)} ${counts.total === 1 ? 'file is' : 'files are'} not accounted for`
            : `Counts don't add up (${counts.total} vs ${accounted})`}
        </p>
      ) : null}
    </section>
  );
}
