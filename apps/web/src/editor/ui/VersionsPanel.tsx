import type { WorkflowVersionInfo } from '@transcoda/contract';
import {
  type KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { api, safe } from '../../api/client.ts';
import { describeError } from '../../api/errors.ts';
import { AuthContext } from '../../auth/AuthProvider.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { GuardedLink } from '../../lib/navigation.tsx';
import { fmtAgo } from '../../lib/time.ts';
import { versionAuthor } from '../model/version-text.ts';

export type VersionListLoad =
  | { status: 'loading' }
  | { status: 'ok'; versions: WorkflowVersionInfo[] }
  | { status: 'failed'; message: string };

/**
 * The workflow's `workflows.versions` list, newest first: fetched for `key` (the page passes the
 * shown and current versions, so a save or another version refetches) and by `reload` ("Try
 * again"). One list serves the version pill's time and the versions panel. A null `key` waits.
 */
export function useVersionList(
  workflowId: string,
  key: string | null,
): { load: VersionListLoad; reload(): void } {
  const [load, setLoad] = useState<VersionListLoad>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key and tick are the refetch triggers.
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoad((l) => (l.status === 'failed' ? { status: 'loading' } : l));
    void safe(api.workflows.versions({ id: workflowId })).then(([error, data]) => {
      if (!live) return;
      setLoad(
        error
          ? { status: 'failed', message: describeError(error).message }
          : { status: 'ok', versions: [...data.versions].sort((a, b) => b.version - a.version) },
      );
    });
    return () => {
      live = false;
    };
  }, [workflowId, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { load, reload };
}

/** "v8 · Layout only · 2 min ago" (+ " · automatic update" / " · another user" when not mine; see `VersionsPanel`). */
function rowText(
  v: WorkflowVersionInfo,
  me: { id: string; username: string } | null,
  active: boolean,
): string {
  const mine = me !== null && v.createdBy === me.id;
  const note = v.note || (mine ? 'saved by you' : 'saved');
  // My own versions don't repeat my name; "saved by you" or the note already says it.
  const author = mine ? '' : ` · ${versionAuthor(v.createdBy, me)}`;
  return `v${v.version} · ${note} · ${fmtAgo(v.createdAt)}${author}${active ? ' · active' : ''}`;
}

/**
 * The version history under the header's pill: a non-modal panel (`role="dialog"`; the canvas
 * stays usable) listing `load` (see `useVersionList`) newest first as "v8 · <note> · <time>".
 * The note falls back to "saved by you" (the current user's own version) or "saved"; an author
 * is added only when it isn't me: "automatic update" for the server's upgrader, else "another
 * user" (never a raw id). A Close button in the title row closes it too.
 * Each row links to `?version=N` (the current version to the plain editor route); the viewed row
 * is `aria-current`; the active one ends " · active" with a check icon. Escape, a click outside
 * (the pill toggles it itself) or a row closes it.
 */
export function VersionsPanel({
  open,
  workflowId,
  currentVersion,
  viewing,
  activeVersion,
  load,
  onRetry,
  onClose,
}: {
  open: boolean;
  workflowId: string;
  currentVersion: number;
  viewing: number;
  /** The workflow's active version, marked " · active" with a check icon; null when none. */
  activeVersion: number | null;
  load: VersionListLoad;
  onRetry(): void;
  onClose(): void;
}) {
  const me = useContext(AuthContext)?.user ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Focus moves into the panel and back to where it came from when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  // A press outside closes it; the panel's wrapper (with the pill) handles its own clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const scope = ref.current?.parentElement ?? ref.current;
      if (scope && e.target instanceof Node && !scope.contains(e.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      className="versions-panel"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="versions-head">
        <h2 id={titleId} className="versions-title">
          Versions
        </h2>
        <button type="button" className="panel-close" aria-label="Close versions" onClick={onClose}>
          <Icon name="cross" size={16} strokeWidth={2.4} />
        </button>
      </div>
      {load.status === 'loading' && <Loading inline />}
      {load.status === 'failed' && (
        <div role="alert" className="alert alert-danger dialog-alert">
          <span>Could not load the versions: {load.message}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {load.status === 'ok' && (
        <ol className="versions-list">
          {load.versions.map((v) => (
            <li key={v.version}>
              <GuardedLink
                href={
                  v.version === currentVersion
                    ? `/workflows/${workflowId}`
                    : `/workflows/${workflowId}?version=${v.version}`
                }
                className="versions-row"
                aria-current={v.version === viewing ? 'page' : undefined}
                onClick={onClose}
              >
                {rowText(v, me, v.version === activeVersion)}
                {v.version === activeVersion && <Icon name="check" size={13} />}
              </GuardedLink>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
