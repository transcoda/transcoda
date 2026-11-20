import { useId } from 'react';
import { Link, useLocation } from 'wouter';
import { useOverrideTitle } from '../lib/pageTitle.ts';

/**
 * The one "not found" state: a page, workflow, job or run that does not exist (or no longer
 * does), with a way back. Every screen uses it, so the wording and the links match. Drawn in the
 * empty state's language: the address as a node whose cable runs into an empty slot.
 */
export function NotFound({
  what = 'page',
  backHref = '/',
  backLabel = 'Back to workflows',
}: {
  /** "page", "workflow", "job", "run". */
  what?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const [location] = useLocation();
  const titleId = useId();
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`;
  useOverrideTitle(title);
  // The second way out: Jobs, or Workflows when the first link already goes to Jobs.
  const other =
    backHref === '/jobs'
      ? { href: '/', label: 'Go to workflows' }
      : { href: '/jobs', label: 'Go to jobs' };
  return (
    <div className="page not-found">
      <section className="not-found-state" role="alert" aria-labelledby={titleId}>
        <div className="lost-chain" aria-hidden="true">
          <span className="lost-node">
            <span className="lost-node-kind">{what}</span>
            <span className="lost-node-path">{location}</span>
          </span>
          <span className="lost-port" />
          <span className="lost-cable" />
          <span className="lost-slot" />
        </div>
        <h1 id={titleId} className="not-found-title">
          {title}
        </h1>
        <p>{`This ${what} does not exist, or it was deleted.`}</p>
        <div className="not-found-actions">
          <Link href={backHref} className="btn btn-primary">
            {backLabel}
          </Link>
          <Link href={other.href} className="btn btn-secondary">
            {other.label}
          </Link>
        </div>
      </section>
    </div>
  );
}
