import { Link } from 'wouter';
import { useOverrideTitle } from '../lib/pageTitle.ts';
import { Icon } from './Icon.tsx';

/**
 * The one "not found" state: a page, workflow, job or run that does not exist (or no longer
 * does), with a way back. Every screen uses it, so the wording and the back link match.
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
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`;
  useOverrideTitle(title);
  return (
    <div className="page not-found">
      <div className="panel not-found-panel" role="alert">
        <Icon name="alert" size={18} round />
        <div>
          <h1 className="not-found-title">{title}</h1>
          <p>{`This ${what} does not exist, or it was deleted.`}</p>
          <Link href={backHref} className="btn btn-secondary btn-sm">
            {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
