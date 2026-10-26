import { Dialog } from '../../components/Dialog.tsx';

/**
 * A save answered `VERSION_CONFLICT`: someone else saved first. The draft stays; the user drops
 * it for the latest version or saves over it (a new version on top — nothing is lost). The dialog
 * stays open while either action runs (`busy`); a failure shows inside it (`error`, with "Try
 * again" repeating the failed action) and the draft is untouched. Escape is "decide later": the
 * dialog closes and the draft stays dirty (not while an action runs). `restoring` (the past
 * version being restored) words it for "Restore as new version", which has no draft to keep.
 */
export function ConflictDialog({
  open,
  currentVersion,
  restoring,
  busy = null,
  error = null,
  onReload,
  onSaveOver,
  onRetry,
  onClose,
}: {
  open: boolean;
  currentVersion: number;
  restoring?: number | undefined;
  busy?: 'reload' | 'save' | null;
  error?: string | null;
  onReload(): void;
  onSaveOver(): void;
  onRetry?(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open={open}
      title={`Someone saved v${currentVersion} while you were editing`}
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== null}
            aria-busy={busy === 'reload'}
            onClick={onReload}
          >
            {restoring === undefined ? 'Reload the latest version' : 'Open the latest version'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            aria-busy={busy === 'save'}
            onClick={onSaveOver}
          >
            {restoring === undefined ? 'Save over it' : 'Restore over it'}
          </button>
        </>
      }
    >
      {restoring === undefined ? (
        <p>
          Your changes are still here. Reload the latest version to drop them, or save over it as a
          new version — v{currentVersion} stays in the history.
        </p>
      ) : (
        <p>
          Someone saved v{currentVersion} since you opened v{restoring}. Restore v{restoring} on top
          of it as a new version, or open the latest version.
        </p>
      )}
      {busy !== null && (
        <p role="status" className="dialog-busy">
          {busy === 'reload' ? 'Loading the latest version…' : 'Saving…'}
        </p>
      )}
      {error && (
        <div role="alert" className="alert alert-danger dialog-alert">
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy !== null}
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
