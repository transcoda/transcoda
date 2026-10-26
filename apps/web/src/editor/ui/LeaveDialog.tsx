import { Dialog } from '../../components/Dialog.tsx';

/**
 * "Leave without saving?": a navigation away from a dirty draft is held until the user picks.
 * "Stay" (Escape too) has the focus, so a stray Enter never drops the draft; while "Save and
 * leave" runs every button waits; a failed save shows here (`error`) and the draft stays.
 */
export function LeaveDialog({
  open,
  saving,
  error = null,
  onSaveAndLeave,
  onLeave,
  onStay,
}: {
  open: boolean;
  saving: boolean;
  error?: string | null;
  onSaveAndLeave(): void;
  onLeave(): void;
  onStay(): void;
}) {
  return (
    <Dialog
      open={open}
      title="Leave without saving?"
      onClose={() => {
        if (!saving) onStay();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            data-autofocus
            disabled={saving}
            onClick={onStay}
          >
            Stay
          </button>
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onLeave}>
            Leave
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            aria-busy={saving}
            onClick={onSaveAndLeave}
          >
            Save and leave
          </button>
        </>
      }
    >
      <p>Your unsaved changes will be lost.</p>
      {saving && (
        <p role="status" className="dialog-busy">
          Saving…
        </p>
      )}
      {error && !saving && (
        <p role="alert" className="alert alert-danger dialog-alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
