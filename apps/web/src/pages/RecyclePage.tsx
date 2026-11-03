import type { RecycledEntry, RecycleListOutput } from '@transcoda/contract';
import { Link, useLocation, useSearch } from 'wouter';
import { api } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Icon } from '../components/Icon.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { Loading } from '../components/Loading.tsx';
import { useAsync } from '../hooks/useAsync.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { usePageTitle } from '../lib/pageTitle.ts';
import { fmtDate } from '../lib/time.ts';
import { usePhone } from '../lib/usePhone.ts';
import { groupRecycled } from '../recycle/groupRecycled.ts';

type Library = NonNullable<RecycleListOutput['library']>;

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;
const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

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

      {library ? <LibraryFolder library={library} phone={phone} /> : null}
    </div>
  );
}

function LibraryFolder({ library, phone }: { library: Library; phone: boolean }) {
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
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(({ entry, sidecars }) => [
                <EntryRow key={entry.path} entry={entry} note={kindNote(entry, false)} />,
                ...sidecars.map((s) => (
                  <EntryRow key={s.path} entry={s} note={kindNote(s, true)} sidecar />
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
}: {
  entry: RecycledEntry;
  note: string | null;
  sidecar?: boolean;
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
    </tr>
  );
}
