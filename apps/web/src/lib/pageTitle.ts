import { useEffect } from 'react';

// The browser tab names the page, then the server (when it has a name): "Jobs · Home · Transcoda".
let server: string | null = null;
let page: string | null = null;

function apply(): void {
  document.title = [page, server, 'Transcoda'].filter(Boolean).join(' · ');
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
