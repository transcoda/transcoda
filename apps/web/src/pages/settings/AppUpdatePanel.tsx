import type { AppUpdateOutput, ReleaseNotes } from '@transcoda/contract';
import { useRef } from 'react';
import { GroupLabel } from '../../components/Headings.tsx';
import { Icon } from '../../components/Icon.tsx';
import { useToast } from '../../components/Toast.tsx';
import { copyShortcut, copyText } from '../../lib/clipboard.ts';
import { fmtStamp } from '../../lib/time.ts';

export const UPDATE_COMMAND = 'docker compose pull transcoda && docker compose up -d transcoda';

type Change = ReleaseNotes['entries'][number];

/** Breaking first (it says what to change after updating), then new, improved, fixed. */
const GROUPS: ReadonlyArray<{ type: Change['type']; label: string }> = [
  { type: 'breaking', label: 'Before you update' },
  { type: 'new', label: 'New' },
  { type: 'improved', label: 'Improved' },
  { type: 'fixed', label: 'Fixed' },
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Release({ release }: { release: ReleaseNotes }) {
  return (
    <li className="app-update-release">
      <h4>
        <span className="mono">{release.version}</span>
        {/* Dates are YYYY-MM-DD: shown in UTC, so no time zone moves them a day. */}
        <span className="app-update-date">
          {fmtStamp(`${release.date}T12:00:00Z`, { relative: false, timeZone: 'UTC' })}
        </span>
      </h4>
      {GROUPS.map(({ type, label }) => {
        const items = release.entries.filter((e) => e.type === type);
        if (items.length === 0) return null;
        return (
          <div key={type} className={`app-update-group is-${type}`}>
            <GroupLabel>
              {type === 'breaking' ? <Icon name="alert" size={14} /> : null}
              {label}
            </GroupLabel>
            <ul>
              {items.map((e) => (
                <li key={e.text}>{e.text}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </li>
  );
}

/**
 * About's update notice: which release is out, the command that updates a compose install (copy),
 * and the notes of every version since the running one. Notice only: Transcoda never updates
 * itself. Shown only when the server's background check found a newer release.
 */
export function AppUpdatePanel({ status }: { status: AppUpdateOutput }) {
  const toast = useToast();
  const pre = useRef<HTMLPreElement>(null);
  const update = status.update;
  if (update === null) return null;

  async function copy() {
    // On plain http there may be no way to write the clipboard: then the command is selected.
    const result = await copyText(UPDATE_COMMAND, pre.current);
    if (result === 'copied') toast.success('Copied');
    else if (result === 'selected') toast.info(`Selected. Press ${copyShortcut()} to copy.`);
    else toast.info(`Select the command and press ${copyShortcut()} to copy.`);
  }

  return (
    <section className="panel app-update" aria-labelledby="app-update-h">
      <div className="app-update-head">
        <span className="app-update-icon" aria-hidden="true">
          <Icon name="download" size={16} />
        </span>
        <div>
          <h2 id="app-update-h">Transcoda {update.version} is available</h2>
          <p className="muted">
            You have {status.current}.{' '}
            <a href={update.url} target="_blank" rel="noreferrer" className="link-muted">
              Release on GitHub
            </a>
          </p>
        </div>
      </div>
      <div className="app-update-how">
        <p className="muted">With Docker Compose, in the folder of your compose file:</p>
        <div className="app-update-command">
          <pre ref={pre} className="mono">
            {UPDATE_COMMAND}
          </pre>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()}>
            <Icon name="copy" size={14} />
            Copy
          </button>
        </div>
        <p className="faint">On Unraid or TrueNAS, update the app from its page there.</p>
      </div>
      {update.releases.length > 0 ? (
        <div className="app-update-notes">
          <GroupLabel>What's new</GroupLabel>
          <ul className="app-update-releases">
            {update.releases.map((r) => (
              <Release key={r.version} release={r} />
            ))}
          </ul>
          {update.olderReleases > 0 ? (
            <p className="muted">
              {plural(update.olderReleases, 'older version')} since yours:{' '}
              <a href={update.changelogUrl} target="_blank" rel="noreferrer" className="link-muted">
                full changelog on GitHub
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
