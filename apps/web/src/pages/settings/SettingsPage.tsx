import { useId } from 'react';
import { Redirect } from 'wouter';
import { Icon } from '../../components/Icon.tsx';
import { NotFound } from '../../components/NotFound.tsx';
import { GuardedLink } from '../../lib/navigation.tsx';
import { usePageTitle } from '../../lib/pageTitle.ts';
import { usePhone } from '../../lib/usePhone.ts';
import { SETTINGS_SECTIONS, type SettingsSection, type SettingsSubPage } from './sections.ts';

const hrefOf = (s: SettingsSection) => `/settings/${s.id}`;

/** The current section (or its sub-page) under its h2 (the page's h1 is "Settings"). */
function SectionBody({ section }: { section: SettingsSection | SettingsSubPage }) {
  const id = useId();
  const { Component } = section;
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 id={id}>{section.title}</h2>
      <Component />
    </section>
  );
}

/**
 * Settings: a sub-nav beside the current section (640 px and wider). On a phone `/settings` is the
 * list of sections and each section has a way back to it. `/settings` on a wider window opens the
 * first section; an unknown section goes back to `/settings`. A sub-page
 * (`/settings/about/licences`) replaces its section's body and keeps the section current; an
 * unknown one goes back to the section.
 */
export function SettingsPage({
  section,
  sub,
}: {
  section?: string | undefined;
  sub?: string | undefined;
}) {
  const phone = usePhone();
  const current = SETTINGS_SECTIONS.find((s) => s.id === section);
  const first = SETTINGS_SECTIONS[0];
  const subPage = current?.subs?.find((p) => p.id === sub);
  usePageTitle(current ? current.title : 'Settings');

  // Keyed: wouter's Redirect navigates on mount only, and one may follow the other.
  if (section !== undefined && !current) {
    return <NotFound backHref="/settings" backLabel="Back to settings" />;
  }
  if (current && sub !== undefined && !subPage) {
    return <Redirect key="section" to={hrefOf(current)} replace />;
  }

  if (!current) {
    if (!phone && first) return <Redirect key="first" to={hrefOf(first)} replace />;
    return (
      <div className="page settings-page">
        <div className="page-head">
          <h1>Settings</h1>
        </div>
        <ul className="settings-list" aria-label="Settings">
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s.id} className="settings-list-item">
              <GuardedLink href={hrefOf(s)} className="settings-list-link">
                <Icon name={s.icon} />
                <span>{s.title}</span>
                <span className="settings-list-chevron">
                  <Icon name="chevron-right" />
                </span>
              </GuardedLink>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (phone) {
    return (
      <div className="page settings-page">
        <h1 className="sr-only">Settings</h1>
        {subPage ? (
          <GuardedLink href={hrefOf(current)} className="settings-back">
            <span aria-hidden="true">‹</span> {current.title}
          </GuardedLink>
        ) : (
          <GuardedLink href="/settings" className="settings-back">
            <span aria-hidden="true">‹</span> Settings
          </GuardedLink>
        )}
        <SectionBody section={subPage ?? current} />
      </div>
    );
  }

  return (
    <div className="page settings-page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings">
          {SETTINGS_SECTIONS.map((s) => {
            const here = s.id === current.id;
            return (
              <GuardedLink
                key={s.id}
                href={hrefOf(s)}
                className={here ? 'settings-nav-item is-active' : 'settings-nav-item'}
                // On a sub-page the section is current, but its link is not this page.
                aria-current={here ? (subPage ? 'true' : 'page') : undefined}
              >
                <Icon name={s.icon} />
                <span>{s.title}</span>
              </GuardedLink>
            );
          })}
        </nav>
        <SectionBody section={subPage ?? current} />
      </div>
    </div>
  );
}
