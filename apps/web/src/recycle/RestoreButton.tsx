import type { RecycleRestoreOutput } from '@transcoda/contract';
import { useState } from 'react';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { useToast } from '../components/Toast.tsx';

/**
 * "Restore original" (or, for a restore's set-aside output, "Put Transcoda's version back"): asks
 * first, naming where the file goes, then calls `recycle.restore` with the recycle entry's `path`.
 * Success is a toast (naming any subtitle file that stayed) and `onDone`; a refusal is a toast
 * with the server's reason. The job page and the Recycle page both use it.
 */
export function RestoreButton({
  path,
  fileName,
  targetPath,
  direction,
  onDone,
}: {
  /** The recycle entry's path. */
  path: string;
  fileName: string;
  /** Where the file goes back to (the job's path). */
  targetPath: string;
  direction: 'restore' | 'undo';
  onDone(out: RecycleRestoreOutput): void;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const restore = direction === 'restore';
  const label = restore ? 'Restore original' : "Put Transcoda's version back";

  async function run(): Promise<void> {
    setConfirm(false);
    setBusy(true);
    const [err, out] = await safe(api.recycle.restore({ path }));
    setBusy(false);
    if (err) {
      const why =
        isDefinedError(err) && err.code === 'RECYCLE_REFUSED'
          ? err.data.reason
          : describeError(err).message;
      toast.error(
        `${restore ? "Couldn't restore the original" : "Couldn't put Transcoda's version back"}: ${why}`,
      );
      return;
    }
    const done = restore ? 'Original restored' : "Transcoda's version is back";
    toast.success(
      out.notRestored.length > 0
        ? `${done}; not brought back: ${out.notRestored.join(', ')}`
        : done,
    );
    onDone(out);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={busy}
        onClick={() => setConfirm(true)}
      >
        {label}
      </button>
      <Dialog
        open={confirm}
        title={restore ? `Restore the original of ${fileName}?` : "Put Transcoda's version back?"}
        tone="default"
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
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void run()}>
              {label}
            </button>
          </>
        }
      >
        <p>
          {restore
            ? `The original goes back to ${targetPath}. Transcoda's version moves to the recycle folder, so you can undo this from there.`
            : `Transcoda's version goes back to ${targetPath}. The original moves to the recycle folder again.`}
        </p>
      </Dialog>
    </>
  );
}
