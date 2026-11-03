import type { RecycledEntry, RecycleListOutput } from '@transcoda/contract';
import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { Loading } from '../components/Loading.tsx';
import { useToast } from '../components/Toast.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtDate } from '../lib/time.ts';
import { usePhone } from '../lib/usePhone.ts';
import { groupRecycled } from '../recycle/groupRecycled.ts';
import { RestoreButton } from '../recycle/RestoreButton.tsx';

type Library = NonNullable<RecycleListOutput['library']>;

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;
const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** What an entry is, when it isn't a plain replaced original. */
function kindNote(entry: RecycledEntry, grouped: boolean): string | null {
  if (entry.kind === 'restored-output') return "Transcoda's version (restored original)";
  if (entry.kind === 'sidecar') {
    return grouped ? 'Subtitle file, comes back with its video' : 'Subtitle file';
  }
  return null;
}

/**
 * The Recycle folder page (#41): one library's recycle folder at a time (`?library=<id>`; without
 * one, the first library with anything in it). Its folder, size and free space, the retention
 * note, and a row per entry with where it came from, its job, when it was recycled and when
 * retention deletes it. A subtitle file sits under its video's original. Cards on a phone.
 *
 * Row actions: Restore original (an original), Put Transcoda's version back (a restore's
 * set-aside output), Delete (asks first; permanent). A subtitle file under its original has none:
 * it comes back with it. Empty folder deletes every entry listed, up to the newest one shown.
 */
export function RecyclePage() {
  usePageTitle('Recycle folder');
  const search = useSearch();
  const [, navigate] = useLocation();
  const asked = new URLSearchParams(search).get('library') ?? undefined;
  const { data, error, loading, reload } = useAsync(
    () => api.recycle.list(asked === undefined ? {} : { libraryId: asked }),
    [asked],
  );
  const phone = usePhone();
  const library = data?.library ?? null;

  return (
    <div className="page recycle-page">
      <div className="page-head page-head-row">
        <h1>Recycle folder</h1>
        {data && data.libraries.length > 0 && library ? (
          <div className="page-actions">
            <ListboxSelect
              label="Library"
              value={library.id}
              options={data.libraries.map((l) => ({
                value: l.id,
                label: `${l.name} (${files(l.files)})`,
              }))}
              onChange={(id) => navigate(`/recycle?library=${encodeURIComponent(id)}`)}
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>Could not load the recycle folder: {describeError(error).message}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}

      {loading && !data ? <Loading /> : null}

      {data && library === null ? (
        <p className="recycle-empty">No libraries yet, so nothing is recycled.</p>
      ) : null}

      {library ? <LibraryFolder library={library} phone={phone} onChanged={reload} /> : null}
    </div>
  );
}

function LibraryFolder({
  library,
  phone,
  onChanged,
}: {
  library: Library;
  phone: boolean;
  onChanged(): void;
}) {
  const groups = groupRecycled(library.entries);
  return (
    <>
      <section className="recycle-summary" aria-label="Folder">
        <p className="recycle-folder mono">{library.folder}</p>
        <p className="head-sub">
          {`${fmtBytes(library.totalBytes)} in the folder`}
          {library.freeBytes !== null ? ` · ${fmtBytes(library.freeBytes)} free on this disk` : ''}
        </p>
        <p className="head-sub">
          {`Originals are deleted after ${days(library.retentionDays)}, or sooner when the disk is low (`}
          <Link href="/settings/recycle">Settings</Link>
          {').'}
        </p>
        {library.entries.length > 0 ? (
          <EmptyFolder library={library} onChanged={onChanged} />
        ) : null}
      </section>

      {groups.length === 0 ? (
        <p className="recycle-empty">Nothing in this library's recycle folder.</p>
      ) : phone ? (
        <div className="recycle-cards">
          {groups.map(({ entry, sidecars }) => (
            <div key={entry.path} className="phone-card">
              <div className="phone-card-head">
                <span className="recycle-file">{entry.relativePath}</span>
                <span className="mono">{fmtBytes(entry.sizeBytes)}</span>
              </div>
              {kindNote(entry, false) ? (
                <span className="phone-card-line">{kindNote(entry, false)}</span>
              ) : null}
              {sidecars.map((s) => (
                <span key={s.path} className="phone-card-line">
                  {`${s.relativePath} · ${fmtBytes(s.sizeBytes)} · subtitle file`}
                </span>
              ))}
              <span className="phone-card-line">
                {`Recycled ${fmtDate(entry.recycledAt)} · Deleted on ${fmtDate(entry.deletesAt)} · `}
                <Link href={`/jobs/${entry.jobId}`}>Job</Link>
              </span>
              <div className="phone-card-actions">
                <EntryActions entry={entry} onChanged={onChanged} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <section className="panel recycle-table">
          <table aria-label={`Recycle folder of ${library.name}`}>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">Job</th>
                <th scope="col">Recycled</th>
                <th scope="col">Deleted</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(({ entry, sidecars }) => [
                <EntryRow
                  key={entry.path}
                  entry={entry}
                  note={kindNote(entry, false)}
                  onChanged={onChanged}
                />,
                ...sidecars.map((s) => (
                  <EntryRow
                    key={s.path}
                    entry={s}
                    note={kindNote(s, true)}
                    sidecar
                    onChanged={onChanged}
                  />
                )),
              ])}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function EntryRow({
  entry,
  note,
  sidecar = false,
  onChanged,
}: {
  entry: RecycledEntry;
  note: string | null;
  sidecar?: boolean;
  onChanged(): void;
}) {
  return (
    <tr className={sidecar ? 'recycle-sidecar' : undefined}>
      <td className="recycle-cell">
        <span className="recycle-file">{entry.relativePath}</span>
        {note ? <span className="recycle-note">{note}</span> : null}
      </td>
      <td className="recycle-cell mono">{fmtBytes(entry.sizeBytes)}</td>
      <td className="recycle-cell">
        <Link href={`/jobs/${entry.jobId}`}>Job</Link>
      </td>
      <td className="recycle-cell">{fmtDate(entry.recycledAt)}</td>
      <td className="recycle-cell">{`Deleted on ${fmtDate(entry.deletesAt)}`}</td>
      <td className="recycle-cell">
        {sidecar ? null : (
          <div className="recycle-actions">
            <EntryActions entry={entry} onChanged={onChanged} />
          </div>
        )}
      </td>
    </tr>
  );
}

/** Restore (or put back) and Delete for one entry. */
function EntryActions({ entry, onChanged }: { entry: RecycledEntry; onChanged(): void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = baseName(entry.relativePath);

  async function remove(): Promise<void> {
    setConfirm(false);
    setBusy(true);
    const [err] = await safe(api.recycle.delete({ path: entry.path }));
    setBusy(false);
    if (err) {
      const why =
        isDefinedError(err) && err.code === 'RECYCLE_REFUSED'
          ? err.data.reason
          : describeError(err).message;
      toast.error(`Couldn't delete ${name}: ${why}`);
    } else {
      toast.success(`Deleted ${name}`);
    }
    onChanged();
  }

  return (
    <>
      {entry.kind === 'sidecar' ? null : (
        <RestoreButton
          path={entry.path}
          fileName={name}
          targetPath={entry.relativePath}
          direction={entry.kind === 'original' ? 'restore' : 'undo'}
          onDone={onChanged}
        />
      )}
      <button
        type="button"
        className="btn btn-sm btn-danger-outline"
        disabled={busy}
        onClick={() => setConfirm(true)}
      >
        Delete
      </button>
      <Dialog
        open={confirm}
        title={`Delete ${name} for good?`}
        tone="danger"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-autofocus
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        }
      >
        <p>This deletes the file from the recycle folder. It can't be undone.</p>
      </Dialog>
    </>
  );
}

/**
 * Empty folder: deletes every entry of the library recycled up to the newest one listed (what the
 * person saw when confirming), skipping any whose job is busy or whose folder can't be reached.
 */
function EmptyFolder({ library, onChanged }: { library: Library; onChanged(): void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const newest = library.entries.reduce(
    (max, e) => (e.recycledAt > max ? e.recycledAt : max),
    library.entries[0]?.recycledAt ?? '',
  );

  async function empty(): Promise<void> {
    setConfirm(false);
    setBusy(true);
    const [err, out] = await safe(
      api.recycle.empty({ libraryId: library.id, throughRecycledAt: newest }),
    );
    setBusy(false);
    if (err) {
      toast.error(`Couldn't empty the recycle folder: ${describeError(err).message}`);
    } else if (out.skipped > 0) {
      toast.info(
        `Deleted ${files(out.removed)}; ${out.skipped} ${
          out.skipped === 1
            ? "was skipped (its job is busy or its folder can't be reached)"
            : "were skipped (their jobs are busy or their folder can't be reached)"
        }`,
      );
    } else {
      toast.success(`Deleted ${files(out.removed)}`);
    }
    onChanged();
  }

  return (
    <div className="recycle-empty-action">
      <button
        type="button"
        className="btn btn-sm btn-danger-outline"
        disabled={busy}
        onClick={() => setConfirm(true)}
      >
        Empty folder
      </button>
      <Dialog
        open={confirm}
        title={`Empty the recycle folder of ${library.name}?`}
        tone="danger"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-autofocus
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void empty()}>
              Empty folder
            </button>
          </>
        }
      >
        <p>{`This deletes ${files(library.entries.length)} (${fmtBytes(library.totalBytes)}) for good.`}</p>
      </Dialog>
    </div>
  );
}
