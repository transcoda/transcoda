import { useEffect } from 'react';

// The browser tab names the page, then the server (when it has a name): "Jobs · Home · Transcoda".
let server: string | null = null;
let page: string | null = null;
// A not-found state's title wins over the page that renders it: the child's effect runs before the
// parent's, so a plain page title would overwrite it ("Settings" on /settings/nope).
let override: string | null = null;

function apply(): void {
  document.title = [override ?? page, server, 'Transcoda'].filter(Boolean).join(' · ');
}

/** The server's name from `auth.me` (null before sign-in or when none is set). */
export function setServerTitle(name: string | null): void {
  server = name;
  apply();
}

/** Names the current page in the tab title while it is shown; null keeps only the server's. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    page = title;
    apply();
    return () => {
      if (page === title) {
        page = null;
        apply();
      }
    };
  }, [title]);
}

/** The not-found state's title: shown instead of the page title of the screen it sits in. */
export function useOverrideTitle(title: string): void {
  useEffect(() => {
    override = title;
    apply();
    return () => {
      if (override === title) {
        override = null;
        apply();
      }
    };
  }, [title]);
}
