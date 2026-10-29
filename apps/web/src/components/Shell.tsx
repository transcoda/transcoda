import { RUNNING_JOB_STATES } from '@transcoda/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { useAuth } from '../auth/useAuth.ts';
import { useJobsCounts } from '../jobs/useJobsList.ts';
import { GuardedLink, guardedRun } from '../lib/navigation.tsx';
import { usePhone } from '../lib/usePhone.ts';
import { TmdbAttribution } from '../plugins/TmdbAttribution.tsx';
import { usePluginsNav } from '../plugins/usePluginsNav.ts';
import { ActivityButton } from './ActivityButton.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Mark, Wordmark } from './Logo.tsx';

function NavLink({
  href,
  icon,
  rail,
  section,
  count,
  countLabel = 'running',
  children,
}: {
  href: string;
  icon: IconName;
  rail: boolean;
  /** Also current under this route pattern (Workflows stays lit inside a workflow). */
  section?: string;
  /** Running jobs, as a pill after the name (screen 07 "Jobs 2"); hidden when 0. */
  count?: number;
  /** What the count is, read after it: "Jobs, 2 running". */
  countLabel?: string;
  children: string;
}) {
  const [exact] = useRoute(href);
  const [within] = useRoute(section ?? href);
  const active = exact || within;
  return (
    <GuardedLink
      href={href}
      className={active ? 'nav-item is-active' : 'nav-item'}
      aria-current={active ? 'page' : undefined}
      title={rail ? children : undefined}
    >
      <Icon name={icon} />
      <span className="nav-label">{children}</span>
      {count ? (
        <>
          <span className="nav-count" aria-hidden="true">
            {count}
          </span>
          <span className="sr-only">{`, ${count} ${countLabel}`}</span>
        </>
      ) : null}
    </GuardedLink>
  );
}

/** The main navigation's id (the phone header's "Menu" button controls it). */
export const MAIN_NAV_ID = 'main-nav';
/** The page's main region: the skip link's target. */
export const MAIN_CONTENT_ID = 'main-content';

function SkipLink() {
  return (
    <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
      Skip to content
    </a>
  );
}

/**
 * The app frame: top bar and side nav. The top bar and the nav stay in view while a long page
 * scrolls. Below 640 px every page gets the same phone header (brand and a Menu button) and the
 * nav becomes a drawer under it, holding the signed-in user and Sign out. `rail` (the editor,
 * screen 05, desktop only) drops the top bar — the editor header carries the way back — and
 * collapses the nav to a 56 px icon rail whose items keep their names (visually hidden, plus a
 * tooltip); the mark links home and sign out sits at the end.
 */

export function Shell({
  children,
  rail: wantsRail = false,
}: {
  children: ReactNode;
  rail?: boolean;
}) {
  const { user, logout, appearance } = useAuth();
  const serverName = appearance.serverName;
  const [error, setError] = useState<string | null>(null);
  // The TMDB terms ask for a notice wherever its data is used: shown while the plugin is installed.
  const { tmdb, updates } = usePluginsNav();
  const jobCounts = useJobsCounts();
  const running = jobCounts ? RUNNING_JOB_STATES.reduce((n, s) => n + jobCounts[s], 0) : 0;
  const phone = usePhone();
  // The icon rail is the editor's desktop frame; on a phone the editor gets the phone header too.
  const rail = wantsRail && !phone;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [location] = useLocation();
  const open = phone && menuOpen;

  // Choosing a destination (or widening the window) closes the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the location is the trigger.
  useEffect(() => setMenuOpen(false), [location, phone]);
  useEffect(() => {
    if (!open) return;
    navRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  async function logOut() {
    setError(null);
    try {
      await logout();
    } catch {
      setError("Couldn't sign out. Try again.");
    }
  }
  // Leaving a dirty editor draft by logging out asks first, like any other way out.
  const onLogout = () => guardedRun(() => void logOut());

  const name = user?.username ?? '';
  const nav = (
    <>
      <NavLink href="/" icon="workflows" rail={rail} section="/workflows/*">
        Workflows
      </NavLink>
      <NavLink href="/jobs" icon="jobs" rail={rail} section="/jobs/*" count={running}>
        Jobs
      </NavLink>
      <NavLink href="/libraries" icon="libraries" rail={rail}>
        Libraries
      </NavLink>
      {/* With updates waiting, the link lands on the Updates tab. */}
      <NavLink
        href={updates > 0 ? '/plugins?show=updates' : '/plugins'}
        icon="plugins"
        rail={rail}
        section="/plugins"
        count={updates}
        countLabel={updates === 1 ? 'update available' : 'updates available'}
      >
        Plugins
      </NavLink>
      <hr className="nav-sep" />
      <NavLink href="/settings" icon="settings" rail={rail} section="/settings/*">
        Settings
      </NavLink>
    </>
  );

  if (rail) {
    return (
      <div className="shell is-rail">
        <SkipLink />
        <div className="shell-body">
          <nav id={MAIN_NAV_ID} aria-label="Main" className="sidenav rail">
            <GuardedLink
              href="/"
              className="rail-home"
              aria-label="Transcoda home"
              title="Transcoda home"
            >
              <Mark size={30} />
            </GuardedLink>
            {nav}
            <button
              type="button"
              className="nav-item rail-logout"
              aria-label={`Sign out ${name}`.trim()}
              title={`Sign out ${name}`.trim()}
              onClick={onLogout}
            >
              <Icon name="log-out" />
            </button>
            {error ? (
              <span className="sr-only" role="alert">
                {error}
              </span>
            ) : null}
          </nav>
          <main id={MAIN_CONTENT_ID} tabIndex={-1} className="shell-main">
            {children}
          </main>
        </div>
      </div>
    );
  }

  const account = (
    <>
      {error ? (
        <span className="topbar-error" role="alert">
          <Icon name="cross" size={14} strokeWidth={2.6} round />
          {error}
        </span>
      ) : null}
      <span className="user">
        <span className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span>{name}</span>
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
        Sign out
      </button>
    </>
  );

  return (
    <div className="shell">
      <SkipLink />
      <header className="topbar">
        <GuardedLink href="/" className="brand">
          <Mark size={30} />
          <Wordmark />
        </GuardedLink>
        {/* On a phone the name is only in the browser tab's title. */}
        {serverName && !phone ? <span className="server-name">{serverName}</span> : null}
        {phone ? <ActivityButton phone /> : null}
        {phone ? (
          <button
            ref={menuRef}
            type="button"
            className="topbar-menu"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls={MAIN_NAV_ID}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name="menu" strokeWidth={2.4} />
          </button>
        ) : (
          <div className="topbar-end">
            <ActivityButton phone={false} />
            {account}
          </div>
        )}
      </header>
      <div className="shell-body">
        <nav
          ref={navRef}
          id={MAIN_NAV_ID}
          aria-label="Main"
          className="sidenav"
          data-open={open ? 'true' : undefined}
        >
          {nav}
          {phone ? <div className="nav-account">{account}</div> : null}
        </nav>
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="shell-main">
          {children}
        </main>
      </div>
      {tmdb && !rail ? (
        <footer className="shell-footer">
          <TmdbAttribution />
        </footer>
      ) : null}
    </div>
  );
}
