import { useId } from 'react';
import { Icon } from '../components/Icon.tsx';
import { type AfterSource, type BeforeAfterJob, compareJob, type Side } from './compareJob.ts';

const AFTER_HEADER: Record<AfterSource, string> = {
  measured: 'After',
  'not-kept': 'After (not kept)',
  planned: 'After (planned)',
  'from-plan': 'After (from the plan)',
};

/** What the legend adds about where After comes from (nothing for the verified output). */
const AFTER_NOTE: Record<AfterSource, string | null> = {
  measured: null,
  'not-kept': 'After is the output this job measured, then threw away.',
  planned: 'After is the plan: nothing was encoded.',
  'from-plan': "This job's output details weren't kept; After is the plan with the measured size.",
};

/**
 * The job page's before/after table (under the result): the file and each track as the source has
 * it and as the output does, so a smaller file explains itself. After is the verified output's
 * probe ("After (not kept)" when a real run threw it away), or the plan: "After (planned)" on a
 * plan-only dry run, "After (from the plan)" for a job whose output probe was not stored. What the output loses (a downmix,
 * a lossy encode, a dropped track…) is amber with an icon and a word, explained to screen readers.
 * On a phone each row stacks Before over After.
 */
export function BeforeAfter({ job }: { job: BeforeAfterJob }) {
  const headingId = useId();
  const comparison = compareJob(job);
  if (!comparison) return null;
  const header = AFTER_HEADER[comparison.after];
  const note = AFTER_NOTE[comparison.after];
  return (
    <section className="panel before-after" aria-labelledby={headingId}>
      <div className="before-after-head">
        <h2 id={headingId}>Before and after</h2>
        <p className="before-after-legend">
          <span className="ba-loss">
            <Icon name="alert" size={14} round />
            Amber
          </span>{' '}
          marks what the output loses.
          {note && ` ${note}`}
        </p>
      </div>
      <div className="ba-table-wrap">
        <table className="ba-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <td />
              <th scope="col">Before</th>
              <th scope="col">{header}</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td data-label="Before">
                  <SideCell side={r.before} />
                </td>
                <td data-label={header}>
                  <SideCell side={r.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One side's values, each kept whole (the comma belongs to the value before it), then its losses. */
function SideCell({ side }: { side: Side }) {
  if (side.tag) return <span className="ba-tag">{side.tag}</span>;
  return (
    <span className="ba-items">
      {keyed(side.items).map(({ item, key, last }) => (
        <span key={key} className="ba-item">
          {last ? item : `${item},`}
        </span>
      ))}
      {side.losses.map((l) => (
        <span key={l.word} className="ba-loss">
          <Icon name="alert" size={14} round />
          {l.word}
          <span className="sr-only">{`: ${l.why}`}</span>
        </span>
      ))}
    </span>
  );
}

/** Items with a stable key each: the text, numbered when it repeats ("—" can). */
function keyed(items: string[]): { item: string; key: string; last: boolean }[] {
  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const n = (seen.get(item) ?? 0) + 1;
    seen.set(item, n);
    return { item, key: `${item}#${n}`, last: i === items.length - 1 };
  });
}
