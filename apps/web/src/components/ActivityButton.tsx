// The top-bar activity widget (#9): what runs and what is queued, as a button with a progress ring
// and a short text, opening a panel with each running job (file, workflow and version, the step it
// is at, its progress) and a link to the Jobs page. Links only, no queue controls (Jan). The visible
// text is aria-hidden and the button's name carries it, so progress ticks are never announced. The
// panel is a disclosure, not a modal: Escape and a mousedown outside close it.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useCatalog } from '../hooks/useCatalog.ts';
import { progressLine, type RingState, stepLine } from '../jobs/activity.ts';
import { JobProgress } from '../jobs/JobProgress.tsx';
import { DryRunBadge } from '../jobs/JobStateChip.tsx';
import { type Job, percentOf, versionText } from '../jobs/jobText.ts';
import { type Activity, useActivity } from '../jobs/useActivity.ts';
import { GuardedLink } from '../lib/navigation.tsx';

export const ACTIVITY_PANEL_ID = 'activity-panel';
/** The page's main region (Shell's MAIN_CONTENT_ID; not imported, Shell imports this file). */
const MAIN_CONTENT_ID = 'main-content';

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 20 px ring: the percent of one encoding job, else a static full ring in the muted tone. */
function Ring({ ring }: { ring: RingState }) {
  const determinate = ring.kind === 'determinate';
  return (
    <svg
      className={`activity-ring ${determinate ? 'is-determinate' : 'is-neutral'}`}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="activity-ring-track" cx="10" cy="10" r={RADIUS} />
      {determinate ? (
        <circle
          className="activity-ring-value"
          cx="10"
          cy="10"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, ring.percent)) / 100)}
          transform="rotate(-90 10 10)"
        />
      ) : null}
    </svg>
  );
}

function JobRow({ job, activity }: { job: Job; activity: Activity }) {
  const { catalog } = useCatalog();
  const step = stepLine(
    job,
    activity.details.get(job.id) ?? null,
    activity.current.get(job.id),
    catalog,
  );
  const progress = job.state === 'encoding' ? progressLine(job) : null;
  const percent = job.state === 'encoding' ? percentOf(job) : null;
  return (
    <li className="activity-job">
      <GuardedLink href={`/jobs/${job.id}`} className="activity-job-file">
        {job.fileName}
      </GuardedLink>
      <span className="activity-job-where">{`${job.workflowName} ${versionText(job)}`}</span>
      <span className="activity-job-step">{step}</span>
      {percent !== null ? <JobProgress job={job} percent={percent} /> : null}
      {progress ? <span className="activity-job-progress">{progress}</span> : null}
      {job.dryRun ? <DryRunBadge testEncode={job.testEncode === true} /> : null}
    </li>
  );
}

function queueLine(a: Activity): string | null {
  const queued = a.queued > 0 ? `${a.queued} queued` : null;
  return [a.paused ? 'Queue paused' : null, queued].filter((x) => x !== null).join(' · ') || null;
}

export function ActivityButton({ phone }: { phone: boolean }) {
  const [open, setOpen] = useState(false);
  // The running ids the open panel asks details for (set after a render, so the hook can read them).
  const [ids, setIds] = useState<readonly string[]>([]);
  const activity = useActivity({ detailsFor: open ? ids : [] });
  const runningKey = activity.running.map((j) => j.id).join(',');
  useEffect(() => {
    setIds((prev) =>
      prev.join(',') === runningKey ? prev : runningKey ? runningKey.split(',') : [],
    );
  }, [runningKey]);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** Focus was inside the widget at the last focus change (it may vanish with it). */
  const focusInside = useRef(false);
  const shown = activity.summary !== null;

  // Choosing a link (a location change) closes the panel.
  const [location] = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the location is the trigger.
  useEffect(() => setOpen(false), [location]);

  // Everything finished: closed, and focus that went with the widget lands on the main content.
  useEffect(() => {
    if (shown) return;
    setOpen(false);
    if (focusInside.current) {
      focusInside.current = false;
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById(MAIN_CONTENT_ID)?.focus();
    }
  }, [shown]);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      focusInside.current = rootRef.current?.contains(e.target as Node) ?? false;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const summary = activity.summary;
  if (!summary) return null;
  const label = summary.allDryRun
    ? summary.label.replace(/^Activity:/, 'Activity, dry run:')
    : summary.label;
  const queue = queueLine(activity);

  return (
    <div ref={rootRef} className={phone ? 'activity is-phone' : 'activity'}>
      <button
        ref={buttonRef}
        type="button"
        className="activity-button"
        aria-expanded={open}
        aria-controls={ACTIVITY_PANEL_ID}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <Ring ring={activity.ring} />
        {phone ? (
          <span className="activity-count" aria-hidden="true">
            {summary.count}
          </span>
        ) : (
          <span className="activity-text" aria-hidden="true">
            {summary.text}
          </span>
        )}
        {summary.allDryRun && !phone ? (
          <span aria-hidden="true">
            <DryRunBadge testEncode={summary.allTestEncode} />
          </span>
        ) : null}
      </button>
      {open ? (
        <section id={ACTIVITY_PANEL_ID} className="activity-panel" aria-label="Activity">
          {activity.running.length > 0 ? (
            <ul className="activity-jobs">
              {activity.running.map((j) => (
                <JobRow key={j.id} job={j} activity={activity} />
              ))}
            </ul>
          ) : null}
          <div className="activity-foot">
            {queue ? <span className="activity-queue">{queue}</span> : null}
            <GuardedLink href="/jobs" className="activity-open">
              Open Jobs
            </GuardedLink>
          </div>
        </section>
      ) : null}
    </div>
  );
}
