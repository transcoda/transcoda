// Maps a path to its route pattern, so an error report names the page (`/jobs/:id`) and never the
// real URL, which can hold ids and names. The patterns are in @transcoda/shared, where the server
// checks a report's route against them; `routes.test.ts` checks them against App.tsx.
import { ROUTE_PATTERNS, UNKNOWN_ROUTE } from '@transcoda/shared';

function matches(pattern: string, segments: string[]): boolean {
  const parts = pattern.split('/').filter(Boolean);
  let i = 0;
  for (const part of parts) {
    const optional = part.endsWith('?');
    const seg = segments[i];
    if (seg === undefined) {
      if (optional) continue;
      return false;
    }
    if (!part.startsWith(':') && part !== seg) return false;
    i += 1;
  }
  return i === segments.length;
}

/** The pattern of the route that draws `pathname`. */
export function routePattern(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  // Two literal matches cannot both fit; between a literal and a parameter the literal comes first.
  const literal = ROUTE_PATTERNS.find((p) => !p.includes(':') && matches(p, segments));
  return literal ?? ROUTE_PATTERNS.find((p) => matches(p, segments)) ?? UNKNOWN_ROUTE;
}
