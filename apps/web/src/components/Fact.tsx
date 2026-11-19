import type { ReactNode } from 'react';

/** One label/value pair in a page header's facts (a job's, a file's). */
export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="job-fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
