import type { FsBrowseDirsOutput } from '@transcoda/contract';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from './Dialog.tsx';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';

/** Shown on a folder Transcoda can read but not write to (a read-only mount or wrong PUID/PGID). */
const READ_ONLY = "Transcoda can't write here";

type Listing =
  | { status: 'loading' }
  | { status: 'ok'; data: FsBrowseDirsOutput }
  | { status: 'error'; message: string };

/** `/media/Shows` as `['media', 'Shows']`; the root is `[]`. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/**
 * Picks a folder on the server (`fs.browseDirs`): breadcrumbs, an Up button and a keyboard
 * navigable list of sub-folders. Starts at `start` (falling back to `/` when it cannot be opened).
 * A folder Transcoda cannot write to is greyed with a reason and can be opened, but "Choose this
 * folder" is off while it is the one shown. `onChoose` gets the folder's real path.
 */
export function FolderPicker({
  open,
  start,
  onChoose,
  onClose,
}: {
  open: boolean;
  start: string;
  onChoose(path: string): void;
  onClose(): void;
}) {
  const [target, setTarget] = useState(start);
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const listRef = useRef<HTMLUListElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  /** The path whose list was last focused, so focus moves once per folder, not per render. */
  const focused = useRef<string | null>(null);
  /** The last folder listed, kept while the next one loads or is refused. */
  const shown = useRef<FsBrowseDirsOutput | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hintId = useId();
  const startRef = useRef(start);
  startRef.current = start;

  // Every opening starts again at the start folder.
  useEffect(() => {
    if (open) {
      focused.current = null;
      shown.current = null;
      setNotice(null);
      setTarget(startRef.current);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The folder already shown: nothing to load (a refused move returns to it).
    if (shown.current?.path === target) return;
    let live = true;
    if (shown.current === null) setListing({ status: 'loading' });
    void (async () => {
      let [err, data] = await safe(api.fs.browseDirs({ path: target }));
      // A typed or remembered start that is gone (or hidden) opens the root instead; once a
      // folder is showing, a refused move stays where it is.
      if (err && shown.current === null && target !== '/') {
        [err, data] = await safe(api.fs.browseDirs({ path: '/' }));
      }
      if (!live) return;
      if (err || !data) {
        if (shown.current !== null) {
          setNotice(`Can't open ${target.slice(target.lastIndexOf('/') + 1) || target}`);
          setTarget(shown.current.path);
        } else setListing({ status: 'error', message: describeError(err).message });
        return;
      }
      shown.current = data;
      setNotice(null);
      setListing({ status: 'ok', data });
    })();
    return () => {
      live = false;
    };
  }, [open, target]);

  // After each folder loads, focus moves to its first entry (or the folder name when empty), so
  // the keyboard never falls back to the page behind.
  useEffect(() => {
    if (listing.status !== 'ok' || focused.current === listing.data.path) return;
    focused.current = listing.data.path;
    const first = listRef.current?.querySelector<HTMLButtonElement>('button');
    (first ?? headRef.current)?.focus();
  }, [listing]);

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0 || at < 0) return;
    e.preventDefault();
    items[next]?.focus();
  }

  const data = listing.status === 'ok' ? listing.data : null;
  const segments = data ? segmentsOf(data.path) : [];
  const crumbs = [{ name: '/', path: '/' }].concat(
    segments.map((name, i) => ({ name, path: `/${segments.slice(0, i + 1).join('/')}` })),
  );

  return (
    <Dialog
      open={open}
      title="Choose a folder"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!data?.writable}
            onClick={() => data?.writable && onChoose(data.path)}
          >
            Choose this folder
          </button>
        </>
      }
    >
      <div className="picker" aria-busy={listing.status === 'loading'}>
        {listing.status === 'error' && (
          <p className="alert alert-danger" role="alert">
            {listing.message}
          </p>
        )}
        {listing.status === 'loading' && <Loading inline />}
        {data && (
          <>
            <div className="picker-bar">
              <nav aria-label="Folder" className="picker-crumbs">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <span key={c.path} className="picker-crumb">
                      {i > 1 && (
                        <span className="faint" aria-hidden="true">
                          /
                        </span>
                      )}
                      {last ? (
                        <span ref={headRef} tabIndex={-1} aria-current="location">
                          {c.name}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="picker-crumb-btn"
                          onClick={() => setTarget(c.path)}
                        >
                          {c.name}
                        </button>
                      )}
                    </span>
                  );
                })}
              </nav>
              {data.parent !== null && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setTarget(data.parent ?? '/')}
                >
                  Up
                </button>
              )}
            </div>
            {!data.writable && (
              <p className="picker-readonly" role="status">
                {READ_ONLY}
              </p>
            )}
            {notice && (
              <p className="picker-error" role="alert">
                {notice}
              </p>
            )}
            <span id={hintId} className="sr-only">
              Use the arrow keys to move between folders and Enter to open one.
            </span>
            <ul
              ref={listRef}
              className="picker-list"
              aria-label="Folders"
              aria-describedby={hintId}
              onKeyDown={onListKeyDown}
            >
              {data.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className={e.writable ? 'picker-item' : 'picker-item is-readonly'}
                    onClick={() => setTarget(e.path)}
                  >
                    <Icon name="folder" size={16} />
                    <span className="picker-name">{e.name}</span>
                    {!e.writable && <span className="picker-hint">{READ_ONLY}</span>}
                  </button>
                </li>
              ))}
              {data.entries.length === 0 && <li className="muted picker-note">No folders here</li>}
            </ul>
            {data.truncated && (
              <p className="muted picker-note">
                Only the first 500 folders are shown. Type the path instead.
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
