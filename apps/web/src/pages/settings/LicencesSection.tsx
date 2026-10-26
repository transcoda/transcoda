import type { ThirdPartyPackage } from '@transcoda/contract';
import { useEffect, useId, useState } from 'react';
import { api } from '../../api/client.ts';
import { Loading } from '../../components/Loading.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { filterLicences } from './licenceSearch.ts';

const PROJECT_LICENCE = 'https://github.com/transcoda/transcoda/blob/main/LICENSE';
/** The status line and the list follow the search once typing pauses this long. */
const SEARCH_PAUSE_MS = 300;

/** One component: a disclosure whose full licence text is rendered only while it is open. */
function LicenceEntry({ pkg, text }: { pkg: ThirdPartyPackage; text: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details className="licence-entry" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="licence-name">{`${pkg.name} ${pkg.version} · ${pkg.licence}`}</span>
          {pkg.origin === 'npm' ? null : <span className="scope-tag">{pkg.origin}</span>}
        </summary>
        {open ? (
          <div className="licence-body">
            {pkg.homepage ? (
              <a href={pkg.homepage} target="_blank" rel="noreferrer" className="licence-home">
                {pkg.homepage}
              </a>
            ) : null}
            <pre className="licence-text">{text ?? 'No licence text in this build.'}</pre>
          </div>
        ) : null}
      </details>
    </li>
  );
}

/**
 * Settings → About → Open-source licences: the third-party components this build ships (npm
 * packages of the web app and the server, the image's ffmpeg, Node and Debian, vendored icon
 * data), searchable by name or licence, each with its full licence text.
 */
export function LicencesSection() {
  const result = useAsync(() => api.system.licences(), []);
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSettled(query), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const intro = (
    <p className="section-intro">
      Transcoda is free software under the{' '}
      <a href={PROJECT_LICENCE} target="_blank" rel="noreferrer">
        GNU GPL v3
      </a>
      . It is built on the components below.
    </p>
  );

  if (result.loading && !result.data) return <Loading />;
  if (!result.data) {
    return (
      <div className="licences">
        {intro}
        <p className="about-error">The licence list could not be loaded.</p>
      </div>
    );
  }
  if (!result.data.available) {
    return (
      <div className="licences">
        {intro}
        <p>
          This build has no licence list. Run <code>pnpm licences</code> (developers) or use the
          release image.
        </p>
      </div>
    );
  }

  const { packages, texts } = result.data;
  const shown = filterLicences(packages, settled);
  const status =
    settled.trim() === ''
      ? `${packages.length} components`
      : `${shown.length} of ${packages.length}`;

  return (
    <div className="licences">
      {intro}
      <div className="licence-search">
        <label htmlFor={searchId}>Search components</label>
        <input
          id={searchId}
          type="search"
          className="input"
          autoComplete="off"
          placeholder="Name or licence"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p role="status" className="faint">
          {status}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="faint">{`No component matches “${settled.trim()}”.`}</p>
      ) : (
        <ul className="licence-list" aria-label="Components">
          {shown.map((p) => (
            <LicenceEntry
              key={`${p.origin}:${p.name}@${p.version}`}
              pkg={p}
              text={texts[p.textKey]}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
