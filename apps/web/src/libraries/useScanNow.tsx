import type { Library, WorkflowSummary } from '@transcoda/contract';
import { runHoursSummary } from '@transcoda/shared';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useLocation } from 'wouter';
import { api, isDefinedError, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Dialog } from '../components/Dialog.tsx';
import { useToast } from '../components/Toast.tsx';
import { type ServerClock, scanWaitText } from './RunHoursCard.tsx';

function uncapitalise(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The "Test-encode" box of a dialog that starts a dry run (a real scan never test-encodes). */
function TestEncodeField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="lib-radio">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>Test-encode</span>
      </label>
      <span id={`${id}-hint`} className="field-hint">
        Encode, verify and measure every file for real, then stop before anything is written.
        Outputs are kept for playing.
      </span>
    </div>
  );
}

/** "Dry run…": the workflows whose newest version's Library input names the library. */
function DryRunDialog({
  library,
  choices,
  returnFocusTo,
  onPick,
  onClose,
}: {
  library: Library | null;
  choices: WorkflowSummary[];
  returnFocusTo: HTMLElement | null;
  onPick(workflow: WorkflowSummary, force: boolean, testEncode: boolean): void;
  onClose(): void;
}) {
  // "Also include files vN already finished" (`force`) and "Test-encode": off every
  // time it opens; the first workflow is picked.
  const [force, setForce] = useState(false);
  const [testEncode, setTestEncode] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const groupId = useId();
  useEffect(() => {
    if (library) {
      setForce(false);
      setTestEncode(false);
      setPicked(null);
    }
  }, [library]);
  const chosen = choices.find((w) => w.id === picked) ?? choices[0] ?? null;
  return (
    <Dialog
      open={library !== null}
      title={`Dry run on ${library?.name ?? ''}`}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={chosen === null}
            onClick={() => chosen && onPick(chosen, force, testEncode)}
          >
            {testEncode ? 'Start test encode' : 'Start dry run'}
          </button>
        </>
      }
    >
      <p>
        {testEncode
          ? `Encodes every file in ${library?.path ?? ''} with the newest version of the workflow you pick and keeps each output to compare. The originals are not changed.`
          : `Plans every file in ${library?.path ?? ''} with the newest version of the workflow you pick. Nothing on disk changes.`}
      </p>
      <fieldset className="lib-dry-list" aria-labelledby={`${groupId}-legend`}>
        <span id={`${groupId}-legend`} className="field-label">
          Workflow
        </span>
        {choices.map((w) => (
          <label key={w.id} className="lib-radio">
            <input
              type="radio"
              name={groupId}
              checked={chosen?.id === w.id}
              onChange={() => setPicked(w.id)}
            />
            <span>{`${w.name} v${w.currentVersion}`}</span>
          </label>
        ))}
      </fieldset>
      <label className="lib-check">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        <span>{`Also include files v${chosen?.currentVersion ?? ''} already finished`}</span>
      </label>
      <TestEncodeField checked={testEncode} onChange={setTestEncode} />
    </Dialog>
  );
}

/**
 * Scan now and Dry run for a library, with their dialogs. Shared by the Libraries list and a
 * library's own page: the caller renders `dialogs` once, opens them with `requestScan` and
 * `requestDryRun`, and disables its buttons while `scanning` is set.
 */
export function useScanNow({
  clock,
  workflows,
  onFeederGone,
}: {
  /** The server's clock, for the run-hours line of the Scan now dialog. */
  clock: ServerClock | null;
  /** The workflow list (empty until it loads). */
  workflows: WorkflowSummary[];
  /** Called when the library's feeder is gone: reload the libraries and the workflows. */
  onFeederGone(): void;
}): {
  /** The id of the library being scanned, or null. */
  scanning: string | null;
  /** Opens the "Scan now?" dialog. */
  requestScan(library: Library): void;
  /** Opens the dry run dialog; `menu` takes focus back when it closes. */
  requestDryRun(library: Library, menu: HTMLElement | null): void;
  /** The workflows a dry run of the library can pick from. */
  dryRunChoices(library: Library): WorkflowSummary[];
  dialogs: ReactNode;
} {
  const toast = useToast();
  const [, navigate] = useLocation();
  const allWorkflows = workflows;
  const [scanning, setScanning] = useState<string | null>(null);
  const [confirmScan, setConfirmScan] = useState<Library | null>(null);
  const [dryRun, setDryRun] = useState<{ library: Library; menu: HTMLElement | null } | null>(null);
  // "Also include files vN already finished" (`force`): off every time the dialog opens.
  // The blocked dialog's "Test-encode" (for its dry run instead): off every time it opens.
  const [testEncode, setTestEncode] = useState(false);
  const [force, setForce] = useState(false);
  useEffect(() => {
    if (confirmScan) {
      setForce(false);
      setTestEncode(false);
    }
  }, [confirmScan]);

  /** The workflows whose newest version's Library input names the library, by name. */
  const dryRunChoices = (library: Library) =>
    allWorkflows
      .filter((w) => w.kind === 'workflow' && w.libraryInput?.id === library.id)
      .sort((a, b) => a.name.localeCompare(b.name));

  /**
   * Queues a run over the whole root. A real scan names no workflow: the server runs the
   * library's feeder (its active version). A dry run names the workflow and plans its newest
   * version; with `testEncode` it encodes and measures for real (a real scan never sends it).
   * `force` also takes files that version already finished; without it the request omits `force`.
   */
  async function scan(
    library: Library,
    dry: { workflowId: string; testEncode: boolean } | null = null,
    force = false,
  ) {
    if (scanning) return;
    setScanning(library.id);
    const [err, queued] = await safe(
      api.jobs.queue({
        ...(dry
          ? {
              path: library.path,
              workflowId: dry.workflowId,
              dryRun: true,
              testEncode: dry.testEncode,
            }
          : { path: library.path, dryRun: false }),
        ...(force ? { force: true } : {}),
      }),
    );
    setScanning(null);
    if (!err && queued) navigate(`/runs/${queued.runId}`);
    else if (isDefinedError(err) && err.code === 'NO_FEEDING_WORKFLOW') {
      // The feeder was deactivated (or moved) since the list loaded.
      toast.error(
        `${library.name} isn't fed by an active workflow. Set it in a workflow's Library input and activate it.`,
      );
      onFeederGone();
    } else if (isDefinedError(err) && err.code === 'WORKFLOW_INVALID') {
      toast.error(
        dry
          ? `The newest version of ${library.name}'s workflow can't run. Fix it in the editor first.`
          : `The active version of ${library.name}'s workflow can't run. Activate a version that runs first.`,
      );
    } else if (isDefinedError(err) && err.code === 'PATH_REJECTED') {
      toast.error(`Couldn't scan ${library.name}: ${err.data.reason}`);
    } else toast.error(`Couldn't scan ${library.name}: ${describeError(err).message}`);
  }

  /** The feeder of the library being confirmed, when the workflow list has it. */
  const scanTarget = confirmScan?.feeds
    ? allWorkflows.find((x) => x.id === confirmScan.feeds?.workflowId)
    : undefined;
  const blocked = scanTarget?.active != null && !scanTarget.active.runnable;
  const blockedId = blocked ? scanTarget.id : null;
  const [blockedIssue, setBlockedIssue] = useState<{ id: string; message: string } | null>(null);
  // The first load error of the active version, for the blocked text; the dialog works without it.
  useEffect(() => {
    setBlockedIssue(null);
    if (blockedId === null) return;
    let live = true;
    api.workflows.get({ id: blockedId }).then(
      (detail) => {
        const first = detail.activeIssues[0];
        if (live && first) setBlockedIssue({ id: blockedId, message: first.message });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [blockedId]);

  /** What the dialog will do: the feeder's active version over the whole root. */
  function scanText(library: Library): string {
    const feeds = library.feeds;
    if (!feeds) return '';
    if (blocked && scanTarget) {
      const why = blockedIssue?.id === scanTarget.id ? blockedIssue.message : 'it has errors';
      return `${feeds.name} v${feeds.version} is active but can't run: ${why}. Activate a version that runs first, or dry run the newest version instead.`;
    }
    return `Applies ${feeds.name} v${feeds.version} (active) to every file in ${library.path}. Files that need changes are rewritten.`;
  }

  /**
   * A real scan held back by the library's run hours says when its files start; with run hours
   * that are open now, it names them.
   */
  const scanWait =
    confirmScan && !blocked
      ? (scanWaitText(confirmScan, clock) ??
        (confirmScan.runHours?.enabled
          ? `Its run hours are open now: ${uncapitalise(runHoursSummary(confirmScan.runHours))}.`
          : null))
      : null;

  /** The force checkbox of Scan now: a real run of the feeder's active version may rewrite files. */
  const forceLabel = `Also include files v${confirmScan?.feeds?.version ?? ''} already finished (they may be rewritten)`;

  const dialogs = (
    <>
      <Dialog
        open={confirmScan !== null}
        title={`Scan ${confirmScan?.name ?? ''} now?`}
        onClose={() => setConfirmScan(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              data-autofocus
              onClick={() => setConfirmScan(null)}
            >
              Cancel
            </button>
            {blocked && scanTarget ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const library = confirmScan;
                  setConfirmScan(null);
                  if (library) void scan(library, { workflowId: scanTarget.id, testEncode });
                }}
              >
                Dry run v{scanTarget.currentVersion} instead
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked}
              onClick={() => {
                const library = confirmScan;
                setConfirmScan(null);
                if (library) void scan(library, null, force);
              }}
            >
              Scan now
            </button>
          </>
        }
      >
        <p>{confirmScan ? scanText(confirmScan) : null}</p>
        {scanWait ? <p>{scanWait}</p> : null}
        {blocked ? (
          // Only the dry run it offers instead can test-encode: a real scan never does.
          scanTarget ? (
            <TestEncodeField checked={testEncode} onChange={setTestEncode} />
          ) : null
        ) : (
          <label className="lib-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>{forceLabel}</span>
          </label>
        )}
      </Dialog>

      <DryRunDialog
        library={dryRun?.library ?? null}
        choices={dryRun ? dryRunChoices(dryRun.library) : []}
        returnFocusTo={dryRun?.menu ?? null}
        onClose={() => setDryRun(null)}
        onPick={(w, force, testEncode) => {
          const library = dryRun?.library;
          setDryRun(null);
          if (library) void scan(library, { workflowId: w.id, testEncode }, force);
        }}
      />
    </>
  );
  return {
    scanning,
    requestScan: setConfirmScan,
    requestDryRun: (library, menu) => setDryRun({ library, menu }),
    dryRunChoices,
    dialogs,
  };
}
