import type { Library, WorkflowSummary } from '@transcoda/contract';
import { isMediaPath } from '@transcoda/shared';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { useToast } from '../components/Toast.tsx';
import { FilePicker } from './FilePicker.tsx';

export const ACTIVATE_TO_RUN = 'Activate a version to run for real';

/** Why a typed folder (or a file that is not media) is refused: Run on a file takes one file. */
export const FILE_ONLY =
  'Pick one media file. To run a whole library, use Scan now on the Libraries page.';

/** The server's PATH_REJECTED reason for a folder sent with `fileOnly`. */
const NOT_A_FILE = 'not a file';

/** "v3 can't run. Activate a version that runs". */
export function cantRunText(version: number): string {
  return `v${version} can't run. Activate a version that runs`;
}

/**
 * Why "Run on a file" is unavailable: a real run uses the active version only, so a workflow
 * without one, or whose active version cannot run, is refused here (the UI never relies on the
 * server's quiet real-to-dry conversion). null: it can run.
 */
export function runBlocked(w: WorkflowSummary): { reason: string } | null {
  if (w.active === null) return { reason: ACTIVATE_TO_RUN };
  if (!w.active.runnable) return { reason: cantRunText(w.active.version) };
  return null;
}

/** Where a real run's original goes: the library's recycle folder or its default in the root. */
export function recycleFolderText(library: Library | null): string {
  if (library === null) return "the library's recycle folder";
  if (library.recycleFolder) return library.recycleFolder;
  const root = library.path.endsWith('/') ? library.path : `${library.path}/`;
  return `${root}.transcoda-recycle`;
}

type Confirm = { path: string; library: Library | null; answer(refused: string | null): void };

/**
 * "Run on a file" (editor header, Workflows row menu): a real run of the workflow's active
 * version on one file. The picker ("Run <name> v<N> on a file") stays open under a confirm
 * ("Run <name> on this file?") that names the file's own library's recycle folder; Run sends
 * `jobs.queue({ path, workflowId, dryRun: false, fileOnly: true })` and opens the job. One file
 * only: a typed path that is not a media file is refused in the picker, and the server refuses a
 * folder (`not a file`), so a real run on a folder only comes from Scan now. PATH_REJECTED answers
 * the picker; WORKFLOW_INVALID closes with a toast; anything else is an alert in the confirm.
 * Cancel returns to the picker. A dirty draft is not saved: the run uses the active version. When
 * the server answers with a dry run (the version was deactivated meanwhile), the job is not
 * opened: "activate to run", the dialogs close and `onStale` refreshes the workflow summary.
 */
export function useRunOnFile(
  workflow: WorkflowSummary | null,
  onStale?: () => void,
): {
  open(): void;
  element: JSX.Element;
} {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(workflow);
  latest.current = workflow;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = useCallback(() => {
    const w = latest.current;
    if (w === null || w.kind !== 'workflow' || runBlocked(w) !== null) return;
    setPicking(true);
  }, []);

  function closeAll() {
    confirm?.answer(null);
    setConfirm(null);
    setPicking(false);
    setFailed(null);
  }

  function onPick(path: string, library: Library | null): Promise<string | null> {
    if (!isMediaPath(path)) return Promise.resolve(FILE_ONLY);
    setFailed(null);
    return new Promise((resolve) => setConfirm({ path, library, answer: resolve }));
  }

  function cancel() {
    if (pending) return;
    confirm?.answer(null);
    setConfirm(null);
    setFailed(null);
  }

  async function run() {
    const w = latest.current;
    if (!confirm || pending || w === null) return;
    const blocked = runBlocked(w);
    if (blocked) {
      toast.error(blocked.reason);
      closeAll();
      return;
    }
    setPending(true);
    setFailed(null);
    const [err, out] = await safe(
      api.jobs.queue({ path: confirm.path, workflowId: w.id, dryRun: false, fileOnly: true }),
    );
    if (!alive.current) return;
    setPending(false);
    if (err) {
      if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
        confirm.answer(err.data.reason === NOT_A_FILE ? FILE_ONLY : err.data.reason);
        setConfirm(null);
        return;
      }
      if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
        toast.error(cantRunText(w.active?.version ?? w.currentVersion));
        closeAll();
        return;
      }
      setFailed(describeError(err).message);
      return;
    }
    if (out.dryRun) {
      // Nothing is active any more (deactivated elsewhere): the server planned instead of running.
      toast.error(ACTIVATE_TO_RUN);
      closeAll();
      onStale?.();
      return;
    }
    const jobId = out.jobIds[0];
    if (jobId === undefined) {
      setFailed('No media file to run there');
      return;
    }
    closeAll();
    navigate(`/jobs/${jobId}`);
  }

  const name = workflow?.name ?? '';
  const version = workflow?.active?.version ?? 0;
  const element = (
    <>
      <FilePicker
        open={picking}
        title={`Run ${name} v${version} on a file`}
        confirmLabel="Choose file"
        note={null}
        onPick={onPick}
        onClose={closeAll}
      />
      <Dialog
        open={confirm !== null}
        title={`Run ${name} on this file?`}
        onClose={cancel}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-autofocus
              disabled={pending}
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              aria-busy={pending}
              onClick={() => void run()}
            >
              Run
            </button>
          </>
        }
      >
        {confirm && (
          <p>
            {`Applies ${name} v${version} (active) to ${confirm.path}. The original moves to ${recycleFolderText(confirm.library)}.`}
          </p>
        )}
        {failed && (
          <p className="alert alert-danger" role="alert">
            {failed}
          </p>
        )}
      </Dialog>
    </>
  );
  return { open, element };
}
