import type { Library, LibraryBrowseOutput } from '@transcoda/contract';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { ListboxSelect } from '../components/ListboxSelect.tsx';
import { Loading } from '../components/Loading.tsx';
import { fmtBytes } from '../lib/bytes.ts';
import { GuardedLink } from '../lib/navigation.tsx';
import { libraryForPath } from './library-for-path.ts';

/** `<root>/<rel>/<name>` with single slashes ('' is the root). */
function joinPath(root: string, ...parts: string[]): string {
  const rest = parts.filter((p) => p !== '').join('/');
  if (rest === '') return root;
  return root.endsWith('/') ? `${root}${rest}` : `${root}/${rest}`;
}

/** A file or folder name with break opportunities after its dots, dashes and underscores, so a long release name wraps between its parts rather than mid-word. */
function breakable(name: string): ReactNode {
  return name.split(/(?<=[._-])/).map((part, i, all) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string, never reordered
    <span key={i}>
      {part}
      {i < all.length - 1 && <wbr />}
    </span>
  ));
}

const DRY_RUN_NOTE =
  'This is a dry run: Transcoda plans what would happen to a file and changes nothing on disk. Pick a file to start it.';

type Folder =
  | { status: 'loading' }
  | { status: 'ok'; data: LibraryBrowseOutput }
  | { status: 'error'; message: string };

/**
 * Picks a media file for a dry run (Jan's answer 3): a library browser (`libraries.browse`) with a
 * typed-path fallback. Clicking a file picks `<library.path>/<folder>/<name>`; the typed path's "Start dry run"
 * picks the typed path as it is. `onPick` may answer with a reason the path was refused
 * (PATH_REJECTED's "outside library root"), shown under the path input. Without libraries it says
 * "Create a library first" and links to them. `onPick` also gets the file's library: the browsed one
 * for a list pick, `libraryForPath` for a typed path (null when no library root holds it).
 * `confirmLabel` names the typed path's button and `note` replaces the dry-run line (null: none),
 * so "Run on a file" can reuse the picker.
 */
export function FilePicker({
  open,
  title,
  onPick,
  onClose,
  confirmLabel = 'Start dry run',
  note = DRY_RUN_NOTE,
}: {
  open: boolean;
  title: string;
  /** Resolves to why the path was refused, or null/undefined when it was taken. */
  onPick(path: string, library: Library | null): Promise<string | null | undefined> | undefined;
  onClose(): void;
  /** The typed path's button (default "Start dry run"). */
  confirmLabel?: string;
  /** The line above the browser (default: the dry-run explanation; null: none). */
  note?: ReactNode;
}) {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [folder, setFolder] = useState<Folder>({ status: 'loading' });
  const [typed, setTyped] = useState('');
  /** Why the typed path was refused (shown under the input). */
  const [error, setError] = useState<string | null>(null);
  /** Why a file picked from the list was refused (shown under the list, where the click was). */
  const [listPickError, setListPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errorId = useId();

  // Every opening starts from the first library's root, without the last attempt's error.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLibraries(null);
    setListError(null);
    setPath('');
    setTyped('');
    setError(null);
    setListPickError(null);
    void safe(api.libraries.list()).then(([err, data]) => {
      if (!live) return;
      if (err) {
        setListError(describeError(err).message);
        return;
      }
      setLibraries(data.libraries);
      setLibraryId(data.libraries[0]?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open || libraryId === null) return;
    let live = true;
    setFolder({ status: 'loading' });
    setListPickError(null);
    void safe(api.libraries.browse({ id: libraryId, path })).then(([err, data]) => {
      if (!live) return;
      if (err) {
        const message =
          isDefinedError(err) && err.code === 'PATH_REJECTED'
            ? `Can't open this folder: ${err.data.reason}`
            : describeError(err).message;
        setFolder({ status: 'error', message });
      } else setFolder({ status: 'ok', data });
    });
    return () => {
      live = false;
    };
  }, [open, libraryId, path]);

  const library = libraries?.find((l) => l.id === libraryId) ?? null;
  const segments = path === '' ? [] : path.split('/');

  /** `fromList`: the file's name when it was clicked in the list (its refusal shows there). */
  async function pick(target: string, fromList: string | null = null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setListPickError(null);
    const owner = fromList === null ? libraryForPath(libraries ?? [], target) : library;
    const refused = await onPick(target, owner);
    setBusy(false);
    if (!refused) return;
    if (fromList === null) setError(refused);
    else setListPickError(`Can't use ${fromList}: ${refused}`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const target = typed.trim();
    if (target !== '') void pick(target);
  }

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="picker" aria-busy={busy}>
        {note !== null && <p className="picker-dry">{note}</p>}
        {listError && (
          <p className="alert alert-danger" role="alert">
            {listError}
          </p>
        )}
        {libraries === null && !listError && <Loading inline />}
        {libraries?.length === 0 && (
          <p className="picker-empty">
            <span>Create a library first</span>{' '}
            <GuardedLink href="/libraries">Libraries</GuardedLink>
          </p>
        )}
        {library && (
          <>
            <div className="field">
              <ListboxSelect
                visibleLabel
                label="Library"
                value={library.id}
                options={(libraries ?? []).map((l) => ({ value: l.id, label: l.name }))}
                onChange={(v) => {
                  setLibraryId(v);
                  setPath('');
                }}
              />
            </div>
            <div className="picker-bar">
              <nav aria-label="Folder" className="picker-crumbs">
                {[library.name, ...segments].map((name, i, all) => {
                  const last = i === all.length - 1;
                  return (
                    <span key={all.slice(0, i + 1).join('/')} className="picker-crumb">
                      {i > 0 && (
                        <span className="faint" aria-hidden="true">
                          /
                        </span>
                      )}
                      {last ? (
                        <span aria-current="location" className="picker-crumb-text" title={name}>
                          {name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="picker-crumb-btn"
                          title={name}
                          onClick={() => setPath(segments.slice(0, i).join('/'))}
                        >
                          {name}
                        </button>
                      )}
                    </span>
                  );
                })}
              </nav>
              {path !== '' && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPath(segments.slice(0, -1).join('/'))}
                >
                  Up
                </button>
              )}
            </div>
            {folder.status === 'loading' && <Loading inline />}
            {folder.status === 'error' && (
              <p className="alert alert-danger" role="alert">
                {folder.message}
              </p>
            )}
            {folder.status === 'ok' && (
              <ul className="picker-list">
                {folder.data.dirs.map((d) => (
                  <li key={`d:${d}`}>
                    <button
                      type="button"
                      className="picker-item"
                      onClick={() => setPath(path === '' ? d : `${path}/${d}`)}
                    >
                      <Icon name="folder" size={16} />
                      <span className="picker-name">{breakable(d)}</span>
                    </button>
                  </li>
                ))}
                {folder.data.files.map((f) => (
                  <li key={`f:${f.name}`}>
                    <button
                      type="button"
                      className="picker-item"
                      disabled={busy}
                      onClick={() => void pick(joinPath(library.path, path, f.name), f.name)}
                    >
                      <Icon name="film" size={16} />
                      <span className="picker-name">{breakable(f.name)}</span>
                      <span className="picker-size mono muted">{fmtBytes(f.sizeBytes)}</span>
                    </button>
                  </li>
                ))}
                {folder.data.dirs.length === 0 && folder.data.files.length === 0 && (
                  <li className="muted picker-note">No folders or media files here</li>
                )}
              </ul>
            )}
            {folder.status === 'ok' && listPickError && (
              <p className="picker-error" role="alert">
                {listPickError}
              </p>
            )}
          </>
        )}
        <form className="picker-typed" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor={inputId}>Or type a path</label>
            <div className="picker-typed-row">
              <input
                id={inputId}
                className="input mono"
                value={typed}
                placeholder={`${library ? joinPath(library.path) : '/media'}/…/file.mkv`}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setTyped(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={busy || typed.trim() === ''}
              >
                {confirmLabel}
              </button>
            </div>
            {error && (
              <p id={errorId} className="picker-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </form>
      </div>
    </Dialog>
  );
}
