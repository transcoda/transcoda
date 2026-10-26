import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Link, useLocation } from 'wouter';

/**
 * What a held navigation continues with once the user lets it go: a route, or an action that
 * leaves the page some other way (log out).
 */
export type NavTarget = { to: string } | { run: () => void };

/** Answers whether `target` may go ahead now; false holds it (the page asks, then continues it). */
export type BeforeNavigate = (target: NavTarget) => boolean;

/**
 * The one page-level guard (the editor while its draft is dirty). wouter has no history blocker,
 * so only navigation that goes through `GuardedLink` / `useGuardedNavigate` / `guardedRun`
 * consults it; the editor's `useLeaveGuard` handles the browser's Back/Forward (`popstate`) and
 * reloads (`beforeunload`) itself.
 */
let beforeNavigate: BeforeNavigate | null = null;

/** Installs `fn` as the guard; the returned function removes it (if it is still the guard). */
export function setBeforeNavigate(fn: BeforeNavigate): () => void {
  beforeNavigate = fn;
  return () => {
    if (beforeNavigate === fn) beforeNavigate = null;
  };
}

export function mayNavigate(to: string): boolean {
  return beforeNavigate ? beforeNavigate({ to }) : true;
}

/** Runs `run` now, or hands it to the guard, which runs it once the user chooses to leave. */
export function guardedRun(run: () => void): void {
  if (!beforeNavigate || beforeNavigate({ run })) run();
}

type GuardedLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className'> & {
  href: string;
  className?: string;
  children?: ReactNode;
};

/** wouter's `Link`, asking the guard first (a modified or non-primary click is not navigation). */
export function GuardedLink({ onClick, ...props }: GuardedLinkProps) {
  function guarded(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (!e.defaultPrevented && !mayNavigate(props.href)) e.preventDefault();
  }
  return <Link {...props} onClick={guarded} />;
}

/** wouter's `navigate`, asking the guard first. */
export function useGuardedNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const [, navigate] = useLocation();
  return (to, opts) => {
    if (mayNavigate(to)) navigate(to, opts);
  };
}
