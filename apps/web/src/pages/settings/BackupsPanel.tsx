import { ORPCError } from '@orpc/client';
import type { Backup, BackupReason } from '@transcoda/contract';
import { useId, useState } from 'react';
import { api } from '../../api/client.ts';
import { Disclosure } from '../../components/Disclosure.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useAsync } from '../../hooks/useAsync.ts';
import { fmtBytes } from '../../lib/bytes.ts';
import { fmtFull, fmtStamp } from '../../lib/time.ts';

const REASONS: Record<BackupReason, string> = {
  migration: 'Before migration',
  build: 'Build change',
  manual: 'Manual',
};

/**
 * About → Database backups: the files in the config folder's `backups/` (names only, never a
 * path), why each was taken, "Back up now" and how to restore one.
 */
export function BackupsPanel() {
  const id = useId();
  const list = useAsync(() => api.system.backups.list(), []);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<Backup | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function onBackUp() {
    // aria-disabled, not disabled: the button keeps focus while the backup runs.
    if (pending) return;
    setPending(true);
    setFailed(null);
    setDone(null);
    try {
      setDone(await api.system.backups.create());
      list.reload();
    } catch (err) {
      setFailed(
        err instanceof ORPCError && err.code === 'RATE_LIMITED'
          ? err.message
          : "Couldn't back up the database",
      );
    } finally {
      setPending(false);
    }
  }

  const backups = list.data?.backups;

  return (
    <section className="about-backups" aria-labelledby={`${id}-title`}>
      <div className="about-backups-head">
        <h3 id={`${id}-title`}>Database backups</h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-disabled={pending || undefined}
          onClick={() => void onBackUp()}
        >
          Back up now
        </button>
      </div>
      <p className="about-backups-hint faint">
        Taken before a migration, when a new build starts and by "Back up now". Transcoda keeps the{' '}
        {list.data?.keep ?? 5} newest of each kind.
      </p>
      {failed ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{failed}</span>
        </div>
      ) : null}
      <p className="about-backups-done" role="status" aria-live="polite">
        {done ? `Backed up to ${done.name}` : ''}
      </p>
      {list.error && !backups ? (
        <p className="about-error">
          <Icon name="alert" size={16} round />
          Backups could not be read
        </p>
      ) : !backups ? (
        <Loading />
      ) : backups.length === 0 ? (
        <p className="faint">No backups yet.</p>
      ) : (
        <ul className="about-backups-list" aria-label="Database backups">
          {backups.map((b) => (
            <li key={b.name}>
              <div className="about-backups-text">
                <span className="mono about-backups-name">{b.name}</span>
                <span className="about-backups-meta">
                  {REASONS[b.reason]} · {fmtBytes(b.size)} ·{' '}
                  <time dateTime={b.createdAt} title={fmtFull(b.createdAt)}>
                    {fmtStamp(b.createdAt, { time: true })}
                  </time>
                </span>
              </div>
              <a
                className="btn btn-secondary btn-sm"
                href={`/api/v1/system/backups/${encodeURIComponent(b.name)}/download`}
                download={b.name}
                aria-label={`Download ${b.name}`}
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="about-backups-hint faint">
        A backup holds the password and API token hashes and the plugin secrets, so keep it private.
      </p>
      {/* The how-to is read once, when it is needed: closed until asked for. */}
      <Disclosure title="Restoring a backup" className="about-backups-help">
        <p className="about-backups-hint faint">
          Plugin secrets are encrypted with <code>secret.key</code> in the config folder, which is
          not part of a backup: without it they cannot be read.
        </p>
        <p className="about-backups-hint faint">
          To restore: stop Transcoda (the container), copy the backup over{' '}
          <code>transcoda.sqlite</code> in the config folder, delete{' '}
          <code>transcoda.sqlite-wal</code> and <code>transcoda.sqlite-shm</code> if they exist,
          then start it again; an older backup is migrated again at start. Restore it next to the
          same <code>secret.key</code>: with another key the plugin secrets cannot be read and have
          to be entered again.
        </p>
      </Disclosure>
    </section>
  );
}
