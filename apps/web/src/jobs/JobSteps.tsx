import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { Icon, type IconName } from '../components/Icon.tsx';
import type { NodeRef } from '../editor/trace/TraceCanvas.tsx';
import type { Decision } from '../editor/trace/traceOverlay.ts';
import {
  type Badge,
  badgeWord,
  pastOf,
  type Step,
  type StepContext,
  type StepDetail,
  stepsHeading,
  steps as stepsOf,
  stepsSummary,
} from './steps.ts';

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** "Retry" for the second attempt, "Retry 2" for the third … */
function retryHeading(attempt: number): string {
  return attempt === 2 ? 'Retry' : `Retry ${attempt - 1}`;
}

const KIND_WORD: Record<string, string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  action: 'Action',
  finish: 'Finish',
  data: 'Data',
};

const KIND_ICON: Record<string, IconName> = {
  trigger: 'kind-trigger',
  condition: 'kind-condition',
  action: 'kind-action',
  finish: 'kind-finish',
  data: 'kind-data',
};

const BADGE_ICON: Record<Badge, IconName> = {
  start: 'play',
  change: 'check',
  same: 'minus',
  check: 'state-queued',
  finish: 'shield',
  yes: 'check',
  no: 'cross',
  failed: 'cross',
  'not-run': 'minus',
};

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

/** The expanded part of a row: the before/after defaults, the video's encode, the languages. */
function Details({ detail, id }: { detail: StepDetail; id: string }) {
  switch (detail.kind) {
    case 'defaults':
      return (
        <div className="step-details step-table-wrap" id={id}>
          <table className="step-table">
            <thead>
              <tr>
                <th scope="col">Track</th>
                <th scope="col">Language</th>
                <th scope="col">Default before</th>
                <th scope="col">Default after</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((r, i) => (
                // An added copy has its source's track name: the place is the key.
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rebuilt whole from the trace.
                <tr key={i}>
                  <td className="mono">{r.track}</td>
                  <td>{r.language}</td>
                  <td className={r.before ? undefined : 'is-off'}>{yesNo(r.before)}</td>
                  <td className={r.after ? 'is-on' : 'is-off'}>{yesNo(r.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'video':
      return (
        <div className="step-details step-tiles" id={id}>
          <div className="step-tile">
            <span className="step-tile-label">Before</span>
            <span>{detail.before}</span>
          </div>
          <div className="step-tile">
            <span className="step-tile-label">After</span>
            <span>{detail.after}</span>
          </div>
          {detail.pixelFormat !== null && (
            <div className="step-tile">
              <span className="step-tile-label">Pixel format</span>
              <span>{detail.pixelFormat}</span>
            </div>
          )}
        </div>
      );
    case 'languages':
      return (
        <ul className="step-details step-chips" id={id}>
          <li>{detail.keep}</li>
          {detail.has.map((h) => (
            <li key={h}>{h}</li>
          ))}
          <li className={detail.drops === null ? 'is-quiet' : undefined}>
            {detail.drops ?? 'Nothing to drop'}
          </li>
        </ul>
      );
  }
}

function Row({
  step,
  past,
  selected,
  onSelect,
}: {
  step: Step;
  past: boolean;
  selected: NodeRef | null;
  onSelect(ref: NodeRef): void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const d = step.decision;
  const isSelected =
    selected !== null &&
    selected.nodeId === d.nodeId &&
    samePath(selected.workflowPath, d.workflowPath);
  const kind = d.kind ?? 'unknown';
  return (
    <li className={`job-step depth-${Math.min(d.depth, 3)}${step.quiet ? ' is-quiet' : ''}`}>
      <span className={`job-step-icon kind-${kind}`} aria-hidden="true">
        {KIND_ICON[kind] ? <Icon name={KIND_ICON[kind]} size={14} strokeWidth={2.4} /> : null}
      </span>
      <div className="job-step-body">
        <div className="job-step-row">
          <button
            type="button"
            className="job-step-main"
            aria-pressed={isSelected}
            onClick={() => onSelect({ workflowPath: d.workflowPath, nodeId: d.nodeId })}
          >
            <span className="job-step-title">
              {KIND_WORD[kind] && (
                <span className={`job-step-kind kind-${kind}`}>{KIND_WORD[kind]}</span>
              )}
              <b>{d.title}</b>
              {d.within && <span className="job-step-within">{` in ${d.within}`}</span>}
              {d.plugin ? (
                <>
                  <Icon name="plug" size={13} />
                  <span className="sr-only">(plugin)</span>
                </>
              ) : null}
            </span>
            <span className="job-step-sentence">{step.sentence}</span>
          </button>
          {step.badge && (
            <span className={`step-badge is-${step.badge}`}>
              <Icon name={BADGE_ICON[step.badge]} size={11} strokeWidth={2.8} />
              {badgeWord(step.badge, past)}
            </span>
          )}
          {step.detail ? (
            <button
              type="button"
              className="job-step-more"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`Details for ${d.title}`}
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} strokeWidth={2.6} />
            </button>
          ) : (
            <span className="job-step-more" aria-hidden="true" />
          )}
        </div>
        {step.notes.map((n, i) => (
          // Two notes may say the same: the place is the key.
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, rebuilt whole from the trace.
          <p key={i} className="job-step-note">
            <Icon name="alert" size={14} round />
            <span>
              {n.text}
              {n.link && (
                <>
                  {' '}
                  <Link href={n.link.href}>{n.link.label}</Link>
                </>
              )}
            </span>
          </p>
        ))}
        {open && step.detail && <Details detail={step.detail} id={detailsId} />}
      </div>
    </li>
  );
}

/** "All steps" / "Only changes": a segmented radio group with arrow keys and one tab stop. */
function Filter({ only, onChange }: { only: boolean; onChange(only: boolean): void }) {
  const options = [
    { value: false, label: 'All steps' },
    { value: true, label: 'Only changes' },
  ];
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    onChange(!only);
    const group = e.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[only ? 0 : 1]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="Show steps" className="job-steps-filter">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with a roving tab stop and arrow keys.
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={o.value === only}
          tabIndex={o.value === only ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Screen 06b "What the workflow would do": one row per node in run order, the node's kind and name,
 * one sentence of what it does (did, in a real run that wrote) and a badge; rows with more behind
 * them expand with the chevron. Notes (an unmet precondition, a target warning) sit under their
 * row. The header counts the steps that change the file, those that do not and the notes, and
 * filters to the changes. A later attempt's steps are grouped under "Retry". Clicking a row
 * selects its node on the canvas; `reveal` (the `?node=` id the page was opened with) scrolls the
 * selected row into view once it is listed.
 */
export function JobSteps({
  items,
  context,
  selected,
  onSelect,
  reveal = null,
}: {
  items: Decision[];
  context: StepContext;
  selected: NodeRef | null;
  onSelect(ref: NodeRef): void;
  reveal?: string | null;
}) {
  const headingId = useId();
  const section = useRef<HTMLElement>(null);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const all = useMemo(() => stepsOf(items, context), [items, context]);
  const past = pastOf(context);
  const heading = stepsHeading(context);
  const counts = stepsSummary(all);
  const shown = onlyChanges ? all.filter((s) => s.badge !== 'same' && s.badge !== 'not-run') : all;
  const revealing =
    reveal !== null && items.some((d) => d.nodeId === reveal && d.workflowPath.length === 0)
      ? reveal
      : null;
  useEffect(() => {
    if (revealing === null) return;
    section.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [revealing]);
  const attempts = [...new Set(shown.map((s) => s.decision.attempt))].sort((a, b) => a - b);
  const first = attempts[0] ?? 1;
  const list = (group: Step[], label: string) => (
    <ol className="job-steps-list" aria-label={label}>
      {group.map((s) => (
        <Row key={s.key} step={s} past={past} selected={selected} onSelect={onSelect} />
      ))}
    </ol>
  );
  return (
    <section ref={section} className="panel job-steps" aria-labelledby={headingId}>
      <div className="job-steps-head">
        <h2 id={headingId}>{heading}</h2>
        {context.dryRun && <span className="badge badge-dry">Dry run</span>}
        {all.length > 0 && (
          <p className="job-steps-counts">
            <span>
              <b>{counts.changing}</b>
              {` ${counts.changing === 1 ? 'step' : 'steps'} ${
                past ? 'changed' : counts.changing === 1 ? 'changes' : 'change'
              } the file`}
            </span>
            <span>
              <b>{counts.unchanged}</b> no change
            </span>
            {counts.notes > 0 && (
              <span>
                <b className="is-note">{counts.notes}</b>
                {` ${counts.notes === 1 ? 'note' : 'notes'}`}
              </span>
            )}
          </p>
        )}
        {all.length > 0 && <Filter only={onlyChanges} onChange={setOnlyChanges} />}
      </div>
      {all.length === 0 ? (
        <p className="job-steps-empty">
          {context.state === 'failed'
            ? 'Stopped before the workflow ran: the result above says why.'
            : 'Nothing decided yet.'}
        </p>
      ) : shown.length === 0 ? (
        <p className="job-steps-empty">No step changes the file.</p>
      ) : (
        attempts.map((attempt) => {
          const group = shown.filter((s) => s.decision.attempt === attempt);
          if (attempt === first) return <div key={attempt}>{list(group, heading)}</div>;
          const label = retryHeading(attempt);
          return (
            <div key={attempt} className="job-steps-retry">
              <h3>{label}</h3>
              {list(group, label)}
            </div>
          );
        })
      )}
    </section>
  );
}
