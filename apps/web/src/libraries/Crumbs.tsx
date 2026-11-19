import { Link } from 'wouter';

export interface Crumb {
  label: string;
  /** Null for the page you are on. */
  href: string | null;
}

export const seasonLabel = (season: string) =>
  season === 'none' ? 'No season' : `Season ${season}`;

/** `Libraries › <Library> › <Show> › Season N`, as the library pages and a file's page draw it. */
export function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="job-crumbs">
      {crumbs.map((c, i) => (
        <span key={c.label} className="library-crumb">
          {i > 0 ? <span aria-hidden="true">›</span> : null}
          {c.href ? (
            <Link href={c.href} className="job-crumb-link">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
