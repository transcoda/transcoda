import { Link } from 'wouter';

export interface Crumb {
  label: string;
  /** Null for the page you are on. */
  href: string | null;
}

export const seasonLabel = (season: string) =>
  season === 'none' ? 'No season' : `Season ${season}`;

/**
 * The key the server gives a show (`showKey` in the library files repo): base64url of the JSON
 * `[title, year]`. A file carries its show's title and year, so its page can name the show's page.
 */
export function showKeyOf(title: string, year: number | null): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify([title, year])))
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

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
