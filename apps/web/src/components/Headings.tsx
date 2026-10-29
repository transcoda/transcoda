// The two heading levels every page uses (conventions 4/5): a section heading (H2) with an
// optional muted count and an explanation on its own muted line, and a muted group label (H3).
// Sentence case and sans; mono capitals stay for table column heads and stat-tile labels.
import type { ReactNode } from 'react';

const num = new Intl.NumberFormat('en-US');

/** "Files 1,866": an H2 with a muted count; `note` is the explanation line under it. */
export function SectionHeading({
  children,
  count,
  note,
  id,
}: {
  children: ReactNode;
  count?: number | null | undefined;
  note?: ReactNode;
  id?: string;
}) {
  const heading = (
    <h2 className="section-h2" id={id}>
      {children}
      {count === undefined || count === null ? null : (
        <span className="section-count">{num.format(count)}</span>
      )}
    </h2>
  );
  if (!note) return heading;
  return (
    <div className="section-head">
      {heading}
      <p className="section-note">{note}</p>
    </div>
  );
}

/** A group label inside a section ("Queue", "Change password"): muted, small, bold. */
export function GroupLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 className="group-h3" id={id}>
      {children}
    </h3>
  );
}
