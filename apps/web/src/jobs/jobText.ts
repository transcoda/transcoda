// What the jobs screens (07, 08) say about a job: its verdict, chip word, detail line and place.
// Pure functions over the `jobs.list` row; the copy follows screen 07's rows.
import type { Job } from '@transcoda/contract';
import { JOB_STATES, type JobState, RUNNING_JOB_STATES } from '@transcoda/shared';
import { fmtBytes, fmtPercent, fmtSaving } from '../lib/bytes.ts';
import { fmtDate } from '../lib/time.ts';

export type { Job };
/** `RUNNING_JOB_STATES` is typed `readonly JobState[]` by the engine, so the union is spelled out. */
export type RunningState =
  | 'probing'
  | 'deciding'
  | 'building'
  | 'encoding'
  | 'verifying'
  | 'replacing';

export type Verdict =
  | 'running'
  | 'queued'
  | 'replaced'
  | 'kept'
  | 'noop'
  | 'skipped'
  | 'failed'
  | 'dry'
  | 'cancelled'
  | 'already'
  | 'attention'
  | 'damaged';

const VERDICT_OF: Record<JobState, Verdict> = {
  queued: 'queued',
  probing: 'running',
  deciding: 'running',
  building: 'running',
  encoding: 'running',
  verifying: 'running',
  replacing: 'running',
  done: 'replaced',
  kept_original: 'kept',
  nothing_to_do: 'noop',
  skipped: 'skipped',
  failed: 'failed',
  dry_run: 'dry',
  cancelled: 'cancelled',
  already_processed: 'already',
};

/**
 * A job that finished `done` but left problems behind (a required plugin finish step failed, the
 * server stopped before the remaining steps) needs attention: the file was replaced, something
 * after it was not. A kept original whose source turned out damaged is "Damaged source", not a
 * plain kept original and never a failure.
 */
export function verdictOf(job: {
  state: JobState;
  problems?: readonly string[];
  result?: { sourceDamaged?: boolean } | null;
}): Verdict {
  if (job.state === 'done' && (job.problems?.length ?? 0) > 0) return 'attention';
  if (job.state === 'kept_original' && job.result?.sourceDamaged === true) return 'damaged';
  return VERDICT_OF[job.state];
}

export const VERDICT_WORD: Record<Verdict, string> = {
  running: 'Running',
  queued: 'Queued',
  replaced: 'Replaced',
  kept: 'Kept original',
  noop: 'Nothing to do',
  skipped: 'Skipped',
  failed: 'Failed',
  dry: 'Dry run',
  cancelled: 'Cancelled',
  already: 'Already processed',
  attention: 'Needs attention',
  damaged: 'Damaged source',
};

export const PHASE_WORD: Record<RunningState, string> = {
  probing: 'Probing',
  deciding: 'Deciding',
  building: 'Building',
  encoding: 'Encoding',
  verifying: 'Verifying',
  replacing: 'Replacing',
};

/** The chip word of a planned job that waits for its lane. */
const PLANNED_WORD = 'Planned';

const isRunning = (s: JobState): s is RunningState => RUNNING_JOB_STATES.includes(s);

/**
 * A job that is planned and waits for a free lane: the engine leaves the state at `building` and
 * names the lane the job waits for (the row's `lane`); a job still building has none yet.
 */
export function isWaitingForLane(job: Pick<Job, 'state' | 'lane'>): boolean {
  return job.state === 'building' && job.lane !== null;
}

/**
 * What a dry run's verdict says: the dry run is a tag (the "Dry run" badge), the word is what
 * would have happened. Only the two outcomes that mean a change get a "would"; nothing to do,
 * failed, skipped and the rest read as they are.
 */
const WOULD_WORD: Partial<Record<Verdict, string>> = {
  dry: 'Would replace',
  kept: 'Would keep original',
  // A dry run that found the damage says the same: the check ran for real.
  damaged: 'Damaged source',
};

/**
 * A plan-only dry run whose size gate decides after encoding (#41): "Would replace if it saves ≥
 * 25%"; null for anything else.
 */
export function dependsWord(job: {
  state: JobState;
  dryRun?: boolean;
  dependsOnSize?: Job['dependsOnSize'];
}): string | null {
  if (!job.dryRun || job.state !== 'dry_run' || !job.dependsOnSize) return null;
  return `Would replace if it saves ≥ ${job.dependsOnSize.minSavingPercent}%`;
}

/** The chip word: the phase while running ("Encoding"), else the verdict (as a "would" in a dry run). */
export function stateWord(
  job: Pick<Job, 'state'> & {
    lane?: Job['lane'];
    problems?: readonly string[];
    result?: { sourceDamaged?: boolean } | null;
    dryRun?: boolean;
    dependsOnSize?: Job['dependsOnSize'];
  },
): string {
  if (job.state === 'building' && job.lane) return PLANNED_WORD;
  if (isRunning(job.state)) return PHASE_WORD[job.state];
  const depends = dependsWord(job);
  if (depends) return depends;
  const verdict = verdictOf(job);
  return (job.dryRun && WOULD_WORD[verdict]) || VERDICT_WORD[verdict];
}

/**
 * The size change a dry run estimates, as the real-run percent words it ("−34%"); null when there
 * is no estimate or no original size to compare it with (never a guess).
 */
export function estimatePercent(before: number | null, estimated: number | null): string | null {
  if (before === null || estimated === null || !(before > 0)) return null;
  return fmtPercent(before, estimated);
}

/**
 * The percent a dry run's chip appends ("Would replace · −34%"); only a dry run that would write.
 * A test-encode measured its output, so it shows the measured size, never the estimate.
 */
export function estimateTag(
  job: Pick<Job, 'state' | 'dryRun' | 'estimatedBytes' | 'result'> & {
    testEncode?: boolean;
    dependsOnSize?: Job['dependsOnSize'];
  },
): string | null {
  if (!job.dryRun || job.state !== 'dry_run') return null;
  // The size gate decides after encoding: no estimate claims what it will decide.
  if (job.dependsOnSize) return null;
  const after = job.testEncode ? (job.result?.afterBytes ?? null) : job.estimatedBytes;
  return estimatePercent(job.result?.beforeBytes ?? null, after);
}

/** The size gate's reason (engine: `saved only ${saving.toFixed(1)}%, below ${min}%`). */
const GATE_REASON = /^saved only (-?[\d.]+)%, below ([\d.]+)%$/;

/** "3.0" → "3", "9.6" → "9.6": a percent as a person reads it. */
const plainNumber = (s: string) => String(Number(s));

/**
 * What a test-encode dry run measured: the outcome ("Would replace", "Would keep the original") and
 * what it rests on ("315 MB → 190 MB (−40%)", "saved only 3% (gate ≥ 10%)"). Null for anything else
 * (a plan-only dry run, a failed test-encode, missing sizes, a kept original the size gate did not
 * decide). The job page's result says the word alone: its size cell has the sizes.
 */
export function testEncodeOutcome(
  job: Pick<Job, 'state' | 'dryRun' | 'testEncode' | 'reason' | 'result'>,
): { word: string; detail: string } | null {
  if (!job.dryRun || !job.testEncode) return null;
  if (job.state === 'dry_run') {
    const before = job.result?.beforeBytes ?? null;
    const after = job.result?.afterBytes ?? null;
    if (before === null || after === null) return null;
    return {
      word: 'Would replace',
      detail: `${fmtBytes(before)} → ${fmtBytes(after)} (${fmtPercent(before, after)})`,
    };
  }
  if (job.state === 'kept_original') {
    const m = job.reason ? GATE_REASON.exec(job.reason) : null;
    if (!m?.[1] || !m[2]) return null;
    return {
      word: 'Would keep the original',
      detail: `saved only ${plainNumber(m[1])}% (gate ≥ ${plainNumber(m[2])}%)`,
    };
  }
  return null;
}

/**
 * A test-encode's outcome in one line, for lists with one cell for it: "Would replace · 315 MB →
 * 190 MB (−40%)" or "Would keep the original · saved only 3% (gate ≥ 10%)"; null as
 * {@link testEncodeOutcome}.
 */
export function testEncodeLine(
  job: Pick<Job, 'state' | 'dryRun' | 'testEncode' | 'reason' | 'result'>,
): string | null {
  const outcome = testEncodeOutcome(job);
  return outcome && `${outcome.word} · ${outcome.detail}`;
}

/** Engine reasons start lower case ("probe failed: …"); the screens print them as sentences. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The queue's reason for an already-processed file: `already <outcome> on <ISO time>`, optionally
 * followed by `; <more>` (a restored original's force hint, C5).
 */
const ALREADY = /^already ([a-z_]+) on ([^\s;]+)(?:; (.+))?$/;

/**
 * A job's reason in words: the queue's "already nothing_to_do on 2026-10-17T04:18:10.386Z"
 * becomes "Processed on 17 Oct 2026: nothing to do", and a nothing-to-do job without a reason (jobs
 * from before the engine said "already as planned") "Already complies with every rule". Anything
 * else is the engine's reason as it is (null when there is none); screens print it with `sentence`.
 */
export function reasonOf(job: Pick<Job, 'state' | 'reason'>): string | null {
  const { state, reason } = job;
  // One wording on every page: the engine's "already as planned" says the same thing.
  if (state === 'nothing_to_do' && (!reason || reason === 'already as planned')) {
    return 'Already complies with every rule';
  }
  // The engine's code for a file changed within the settle window, said as what happens next.
  if (reason === 'still growing') {
    return 'Changed in the last few minutes: it is picked up once it stops changing';
  }
  if (state === 'already_processed' && reason) {
    const m = ALREADY.exec(reason);
    const outcome = m?.[1] as JobState | undefined;
    const at = m?.[2];
    const more = m?.[3] ? `; ${m[3]}` : '';
    if (outcome && at && JOB_STATES.includes(outcome) && !Number.isNaN(Date.parse(at))) {
      return `Processed on ${fmtDate(at)}: ${stateWord({ state: outcome }).toLowerCase()}${more}`;
    }
  }
  return reason;
}

/** "40 s", "3 min", "1 h 23 min": a time left, rounded to what a person reads. */
export function fmtTimeLeft(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "ETA 40 s", "ETA 3 min", "ETA 1 h 23 min" */
export function fmtEta(seconds: number): string {
  return `ETA ${fmtTimeLeft(seconds)}`;
}

/** Whole percent of an encoding job, or null without one. */
export function percentOf(job: Job): number | null {
  const p = job.progress?.percent;
  return p === null || p === undefined ? null : Math.min(100, Math.max(0, Math.round(p)));
}

/** fps and ETA of an encoding job ("118 fps", "ETA 3 min"); either is left out when unknown. */
function speedParts(job: Job): string[] {
  const parts: string[] = [];
  const fps = job.progress?.fps;
  const eta = job.progress?.etaSeconds;
  if (fps !== null && fps !== undefined) parts.push(`${Math.round(fps)} fps`);
  if (eta !== null && eta !== undefined) parts.push(fmtEta(eta));
  return parts;
}

const RUNNING_DETAIL: Record<Exclude<RunningState, 'encoding'>, string> = {
  probing: 'Reading the file',
  deciding: 'Deciding',
  building: 'Building the plan',
  verifying: 'Checking duration, streams and decode',
  replacing: 'Replacing the original',
};

/** A verifying job's detail: its checks counted, the whole-file decode measured, or words only. */
function verifyDetail(job: Job): string {
  const v = job.progress?.verify;
  if (v?.stage === 'checks' && v.done !== null && v.total !== null) {
    return `${RUNNING_DETAIL.verifying} · ${v.done} of ${v.total} done`;
  }
  if (v?.stage === 'full-decode') {
    const pct = percentOf(job);
    return [
      'Decoding the whole file',
      ...(pct === null ? [] : [`${pct}%`]),
      ...speedParts(job),
    ].join(' · ');
  }
  if (v?.stage === 'source') return 'Decoding the same spots of the source';
  return RUNNING_DETAIL.verifying;
}

/**
 * What a running job's node and header say ("Encoding · 42%", "Verifying · 3 of 14 checks"):
 * the phase word and its measure, if any; "Paused" while paused; undefined for a job not running.
 * Verify checks are counted, not given as a percent (each check is a different amount of work).
 */
export function activityLine(job: Job): string | undefined {
  if (job.paused) return 'Paused';
  if (!isRunning(job.state)) return undefined;
  const word = PHASE_WORD[job.state];
  const pct = percentOf(job);
  const v = job.progress?.verify;
  if (job.state === 'verifying' && v) {
    if (v.stage === 'checks' && v.done !== null && v.total !== null) {
      return `${word} · ${v.done} of ${v.total} checks`;
    }
    if (v.stage === 'full-decode') return `${word} · whole file${pct === null ? '' : ` ${pct}%`}`;
    return `${word} · checking the source`;
  }
  return pct === null ? word : `${word} · ${pct}%`;
}

/**
 * When a job its library's run hours hold back can start: "starts at 22:00" today, "starts Sat
 * 09:00" on a later day (the server's wall clock), or that no hours are chosen.
 */
export function runHoursWait(hold: NonNullable<Job['heldByRunHours']>, now: Date): string {
  if (hold.opensAt === null) return 'none are chosen for this library';
  const opens = new Date(hold.opensAt);
  const day = (d: Date) =>
    d.toLocaleDateString('en-GB', { timeZone: hold.timeZone, weekday: 'short', day: 'numeric' });
  const time = opens.toLocaleTimeString('en-GB', {
    timeZone: hold.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const weekday = opens.toLocaleDateString('en-GB', { timeZone: hold.timeZone, weekday: 'short' });
  return day(opens) === day(now) ? `starts at ${time}` : `starts ${weekday} ${time}`;
}

/**
 * The line under the progress bar (screen 07's detail column). `queuePaused`: the whole queue is
 * paused, so a queued job is not waiting for a lane but for the queue. A job its library's run
 * hours hold back says when it can start (`now` for tests).
 */
export function detailLine(job: Job, opts: { queuePaused?: boolean; now?: Date } = {}): string {
  const hold = job.heldByRunHours;
  const held = hold
    ? `waiting for run hours · ${runHoursWait(hold, opts.now ?? new Date())}`
    : null;
  switch (job.state) {
    case 'encoding': {
      const pct = percentOf(job);
      if (pct === null) return 'Encoding';
      return [`${pct}%`, ...speedParts(job)].join(' · ');
    }
    case 'building':
      if (held && isWaitingForLane(job)) return `Planned · ${held}`;
      return isWaitingForLane(job)
        ? `Planned · waiting for ${job.lane === 'encode' ? 'the encoder' : 'the quick lane'}`
        : RUNNING_DETAIL.building;
    case 'replacing':
      // C4: the replace waits for free space ("waiting for 5.4 GB free on /media (5.1 GB free)").
      return job.reason ? sentence(job.reason) : RUNNING_DETAIL.replacing;
    case 'verifying':
      return verifyDetail(job);
    case 'probing':
    case 'deciding':
      return RUNNING_DETAIL[job.state];
    case 'queued':
      if (job.paused) return 'Paused';
      if (opts.queuePaused) return 'Queue paused';
      return held ? sentence(held) : 'Waiting for a lane';
    case 'done': {
      const first = job.problems[0];
      if (first !== undefined) return `done · needs attention: ${first}`;
      const r = job.result;
      if (!r || r.beforeBytes === null || r.afterBytes === null) return 'Replaced';
      const sizes = `${fmtBytes(r.beforeBytes)} → ${fmtBytes(r.afterBytes)}, ${fmtSaving(r.beforeBytes, r.afterBytes)}`;
      // The chip already says "Replaced"; only the recycle folder is worth a word (the original
      // is not gone), never "original replaced".
      return r.replacedTo === 'recycle' ? `${sizes} · original in recycle folder` : sizes;
    }
    case 'kept_original':
      // The "Kept original" chip says the file is untouched; the line only adds why.
      return job.reason ? sentence(job.reason) : '';
    case 'failed':
      return job.reason ? `${sentence(job.reason)} · original untouched` : 'Original untouched';
    case 'skipped':
      return job.reason ? sentence(job.reason) : 'Skipped';
    case 'nothing_to_do':
      return 'Already complies with every rule';
    case 'dry_run':
      // A test-encode measured its output: it says what it found, not that a plan is ready.
      if (job.testEncode) return testEncodeLine(job) ?? WOULD_WORD.dry ?? 'Would replace';
      // The plan itself, worded as on the run page ("Convert 1 video track").
      return job.planSummary || job.reason
        ? sentence(job.planSummary ?? job.reason ?? '')
        : 'Plan ready';
    case 'cancelled':
      return 'Cancelled · original untouched';
    case 'already_processed': {
      const reason = reasonOf(job);
      return reason ? sentence(reason) : 'Already processed';
    }
  }
}

/** The running card's line on a phone (screen 08): "Encoding · 118 fps · ETA 3 min". */
export function phoneRunningLine(job: Job): string {
  if (job.state === 'encoding') return ['Encoding', ...speedParts(job)].join(' · ');
  return detailLine(job);
}

/**
 * A write step's reason as a dry run words it: "replace the original (…)" → "would replace the
 * original (…)"; a dry run never changed anything, so it never reads as done. Other reasons and
 * ones that already say "would" are left as they are.
 */
export function wouldText(reason: string): string {
  return /^(replace|move|copy) /.test(reason) ? `would ${reason}` : reason;
}

/** What a dry run its size gate decides says on its Replace original step (#41). */
export const REPLACE_IF_GATE_PASSES =
  'would replace the original if the size gate passes; otherwise keeps it';

/**
 * {@link wouldText} for a dry run whose size gate decides after encoding: the write steps are
 * conditional ("would replace the original if the size gate passes; otherwise keeps it", "would
 * move the result to /out if the size gate passes; otherwise keeps it").
 */
export function dependsOnSizeText(reason: string): string {
  if (/^replace the original\b/.test(reason)) return REPLACE_IF_GATE_PASSES;
  if (/^(move|copy) /.test(reason)) {
    return `would ${reason} if the size gate passes; otherwise keeps it`;
  }
  return wouldText(reason);
}

/** The first clause of a reason, lower case ("Only 6% smaller, size gate …" → "only 6% smaller"). */
function shortReason(reason: string | null): string | null {
  if (!reason) return null;
  const first = reason.split(/[,;]/)[0]?.trim() ?? '';
  return first ? first.charAt(0).toLowerCase() + first.slice(1) : null;
}

/** A finished row on a phone (screen 08): `${VERDICT_WORD} · ${short reason}`. */
export function phoneLine(job: Job): string {
  const verdict = verdictOf(job);
  const word = stateWord(job);
  let short: string | null = null;
  switch (verdict) {
    case 'replaced': {
      const r = job.result;
      short =
        r && r.beforeBytes !== null && r.afterBytes !== null
          ? fmtSaving(r.beforeBytes, r.afterBytes)
          : null;
      break;
    }
    case 'failed':
    case 'cancelled':
      short = 'original untouched';
      break;
    case 'attention':
      short = shortReason(job.problems[0] ?? null);
      break;
    case 'noop':
      short = null;
      break;
    default:
      short = shortReason(reasonOf(job));
  }
  const line = short ? `${word} · ${short}` : word;
  // A dry run is a tag, not an outcome: it says so up front, then what would have happened.
  return job.dryRun ? `Dry run · ${line}` : line;
}

/** The one accessible name of a job's link on the Jobs and Run pages: "Details for <file>". */
export const detailsLinkName = (fileName: string) => `Details for ${fileName}`;

/** "Shows · TV cleanup " (the where-line before its version). */
export function wherePrefix(job: Job): string {
  return `${job.libraryName} · ${job.workflowName} `;
}

/** "v7" */
export function versionText(job: Job): string {
  return `v${job.workflowVersion}`;
}

/** "Shows · TV cleanup v7" */
export function whereLine(job: Job): string {
  return `${wherePrefix(job)}${versionText(job)}`;
}

/** What a queued real job's version means; it can change before the job starts. */
export const QUEUED_VERSION_NOTE = 'runs on the version active when it starts';

/**
 * The filter chips in order. `states: []` is "All" (no state filter); "Paused" is the paused flag
 * over the active states (client-side: the API filters by state only).
 */
export const FILTERS: ReadonlyArray<{
  label: string;
  states: JobState[];
  paused?: true;
  /** Only jobs with problems (a `done` job whose finish steps went wrong). */
  problems?: true;
  /** Only plan-only dry runs whose size gate decides after encoding (#41). */
  dependsOnSize?: true;
}> = [
  { label: 'All', states: [] },
  { label: 'Running', states: [...RUNNING_JOB_STATES] },
  { label: 'Queued', states: ['queued'] },
  { label: 'Replaced', states: ['done'] },
  { label: 'Kept original', states: ['kept_original'] },
  { label: 'Nothing to do', states: ['nothing_to_do'] },
  { label: 'Skipped', states: ['skipped'] },
  { label: 'Failed', states: ['failed'] },
  // A dry run is a tag on every outcome; this chip is the outcome only a dry run has, worded as
  // every page words it (a dry run that would do nothing counts under Nothing to do).
  { label: 'Would replace', states: ['dry_run'] },
  { label: 'Depends on size', states: ['dry_run'], dependsOnSize: true },
  { label: 'Cancelled', states: ['cancelled'] },
  { label: 'Needs attention', states: [], problems: true },
  { label: 'Paused', states: ['queued', ...RUNNING_JOB_STATES], paused: true },
];
