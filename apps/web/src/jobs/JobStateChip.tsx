import { Icon, type IconName } from '../components/Icon.tsx';
import { estimateTag, type Job, stateWord, type Verdict, verdictOf } from './jobText.ts';

/** One icon per verdict (screen 07's chips; cancelled and already processed are not drawn). */
export const VERDICT_ICON: Record<Verdict, IconName> = {
  running: 'state-running',
  queued: 'state-queued',
  replaced: 'check',
  kept: 'state-kept',
  noop: 'state-noop',
  skipped: 'state-skipped',
  failed: 'cross',
  dry: 'eye',
  cancelled: 'x-circle',
  already: 'check-circle',
  attention: 'alert',
  damaged: 'alert',
};

/** "Dry run": the one mark every dry-run job and run carries, so none can pass for a real one. */
/**
 * The dashed badge of a dry run: "Dry run" for a plan, "Test encode" for one that encoded and kept
 * its output (the two look different, so a plan is never taken for a measured result).
 */
export function DryRunBadge({ testEncode = false }: { testEncode?: boolean }) {
  return (
    <span className={testEncode ? 'badge badge-dry badge-test-encode' : 'badge badge-dry'}>
      <Icon name={testEncode ? 'video' : 'eye'} size={12} />
      {testEncode ? 'Test encode' : 'Dry run'}
    </span>
  );
}

/**
 * The state chip of screen 07: icon + word, coloured from the `--st-*` tokens (`.job-chip.is-*`).
 * A dry run is a tag, not an outcome: the chip says what would have happened ("Would replace") and
 * the dashed "Dry run" badge sits beside it. A paused job gets a second "Paused" chip; its state
 * stays.
 */
export function JobStateChip({ job }: { job: Job }) {
  const verdict = verdictOf(job);
  return (
    <span className="job-chips">
      <span className={`job-chip is-${verdict}`}>
        <Icon name={VERDICT_ICON[verdict]} size={13} strokeWidth={2.6} />
        {[stateWord(job), estimateTag(job)].filter(Boolean).join(' · ')}
      </span>
      {job.dryRun ? <DryRunBadge testEncode={job.testEncode === true} /> : null}
      {job.paused ? (
        <span className="job-chip is-paused">
          <Icon name="pause" size={13} strokeWidth={2.6} />
          Paused
        </span>
      ) : null}
    </span>
  );
}
